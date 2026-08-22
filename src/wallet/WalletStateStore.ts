import { ACTIVE_WALLET_KEY, ACTIVE_WALLET_TTL_MS } from "../constants";
import { cookie } from "../storage";
import {
  getIdentityCookieDomain,
  getIdentityCookieSecurity,
} from "../storage/cookiePolicy";
import { logger } from "../logger";
import { validateAddress, validateAndChecksumAddress } from "../utils/address";
import { isSolanaChainId } from "../solana";
import {
  Address,
  ChainID,
  ChainNamespace,
  ChainState,
  EIP1193Provider,
  EvmChainState,
} from "../types";

/**
 * A ticket identifying one wallet observation, taken before any async work.
 * See `WalletStateStore.observe`.
 */
export interface Observation {
  readonly id: number;
  readonly namespace: ChainNamespace;
}

/** What the store needs from the SDK that owns it. */
export interface WalletStateStoreDeps {
  /** Opt-out or an excluded timezone: purge persisted identity, don't keep it. */
  isPersistedIdentityPurgeRequired(): boolean;
  /** Excluded host or path: skip writing and restoring, but keep the cookie. */
  isPageExcluded(): boolean;
  /** Any visitor-level or page-level suppression: never LEARN a wallet. */
  isTrackingSuppressed(): boolean;
  /** Whether the identity cookie is shared across subdomains. */
  crossSubdomainCookies(): boolean;
  /**
   * The last chain heard from a provider, or undefined if none.
   *
   * Used to refuse a captured chain the wallet has since left. That state
   * belongs to provider tracking, so the store asks rather than owns it.
   */
  providerChainId(provider: EIP1193Provider): number | undefined;
  /**
   * A provider stopped being the active one.
   *
   * From the SDK's point of view its connection has ended, so whatever the
   * owner records about it (a reported connect, for one) must stop counting.
   * The active provider is reassigned from several paths, so the store
   * reports it centrally rather than each caller remembering to.
   */
  onProviderDisplaced(previous: EIP1193Provider): void;
}

/**
 * Wallet identity and chain state, and the cookie that outlives the page.
 *
 * Split out of `FormoAnalytics` so there is one owner for "which wallet is
 * active, on which chain". Before this, `_chainState`, the derived
 * `currentAddress`/`currentChainId`, the active-wallet cookie and the session
 * generation were manipulated from a dozen places across a 3400-line class,
 * which is what made the ordering races in #341 possible to write.
 */
export class WalletStateStore {
  private state: { evm: EvmChainState; solana: ChainState } = {
    evm: {},
    solana: {},
  };

  /**
   * Which namespace last claimed the wallet slot. Last-connected wins, so an
   * EVM connect after a Solana one repoints the derived values, and vice
   * versa, rather than one namespace permanently shadowing the other.
   */
  private _activeNamespace?: ChainNamespace;

  /** Which namespace currently owns the derived values, if any. */
  get activeNamespace(): ChainNamespace | undefined {
    return this._activeNamespace;
  }

  /**
   * Ticket counter for wallet observations.
   *
   * Every signal from a wallet is handled asynchronously: resolving an
   * address, emitting an event. Between the moment a handler decides what to
   * do and the moment it commits, a newer signal can arrive and be fully
   * processed. Whichever handler resumes last then writes its captured data
   * over the newer state.
   *
   * Bespoke guards were added for each case as it was found - a per-provider
   * disconnect count, a per-namespace session generation, a "currently
   * processing" flag - and a fourth review round kept producing new ones,
   * because each guard answers one question and none establishes an order.
   *
   * A ticket does. A handler takes one before its first await; anything it
   * commits afterwards is refused if a newer observation has claimed the
   * namespace since.
   */
  private observationSeq = 0;
  private newestObservation: Record<ChainNamespace, number> = {
    evm: 0,
    solana: 0,
  };

  /**
   * How many disconnects a namespace has begun.
   *
   * Separate from the observation ticket on purpose, because they answer
   * different questions. A ticket asks "is the state I captured still the
   * newest?", which is what a switch or a probe needs. This asks "did the
   * wallet go away after I started?", which is what a connect handler needs.
   *
   * Conflating them loses connects: a connect observation superseded by a
   * NEWER connect must still be reported by somebody, and the ticket cannot
   * tell that apart from being superseded by a disconnect.
   */
  private disconnectCount: Record<ChainNamespace, number> = {
    evm: 0,
    solana: 0,
  };

  /** Derived from the active namespace. Read by integrations and by events. */
  address?: Address;
  chainId?: ChainID;

  constructor(private readonly deps: WalletStateStoreDeps) {}

  // ── reads ────────────────────────────────────────────────────────────────

  /** Which namespace a chain id belongs to. */
  namespaceOf(chainId?: ChainID): ChainNamespace {
    return isSolanaChainId(chainId) ? "solana" : "evm";
  }

  get evmAddress(): Address | undefined {
    return this.state.evm.address;
  }

  get evmChainId(): ChainID | undefined {
    return this.state.evm.chainId;
  }

  get provider(): EIP1193Provider | undefined {
    return this.state.evm.provider;
  }

  /**
   * Take a ticket for an observation about to be processed.
   *
   * MUST be called before the handler's first await, so the order recorded is
   * the order the signals arrived in, not the order their async work happens
   * to finish in.
   */
  observe(namespace: ChainNamespace): Observation {
    const id = ++this.observationSeq;
    this.newestObservation[namespace] = id;
    return { id, namespace };
  }

  /**
   * Record that a namespace's wallet is being torn down.
   *
   * Called at EVERY teardown site before anything is awaited, and whether or
   * not a disconnect event will be emitted: whether the app opted into
   * disconnect autocapture has no bearing on ordering.
   */
  beginDisconnect(namespace: ChainNamespace): void {
    this.disconnectCount[namespace]++;
  }

  /** How many disconnects this namespace has begun so far. */
  disconnectsSoFar(namespace: ChainNamespace): number {
    return this.disconnectCount[namespace];
  }

  /**
   * The newest observation for a namespace, for a caller that must NOT
   * supersede its own caller.
   *
   * `disconnect()` is reached both directly by a consumer and from a handler
   * that already holds a ticket. Taking a fresh ticket there would invalidate
   * the handler that called it. Reading the current value and checking it
   * later asks the same question without changing the answer for anyone else.
   */
  snapshot(namespace: ChainNamespace): number {
    return this.newestObservation[namespace];
  }

  /** Whether nothing newer has claimed the namespace since `snapshot`. */
  isUnchangedSince(namespace: ChainNamespace, snapshot: number): boolean {
    return this.newestObservation[namespace] === snapshot;
  }

  /**
   * Whether this observation is still the newest for its namespace.
   *
   * False means a newer signal arrived while this handler was suspended, and
   * it must abandon whatever it captured rather than write it over the newer
   * state. Superseding, not dropping: the newer handler is already running.
   */
  isCurrent(observation: Observation): boolean {
    return this.newestObservation[observation.namespace] === observation.id;
  }

  // ── writes ───────────────────────────────────────────────────────────────

  set provider(next: EIP1193Provider | undefined) {
    this.displaceProvider(this.state.evm.provider, next);
    this.state.evm.provider = next;
  }

  /**
   * Update a namespace and re-derive `address`/`chainId`.
   *
   * Accepts a namespace or a chain id. A chain id is also stored as the
   * namespace's chain unless the update names one explicitly.
   */
  set(
    namespaceOrChainId: ChainNamespace | ChainID | undefined,
    update: { address?: Address; chainId?: ChainID; provider?: EIP1193Provider }
  ): void {
    const namespace =
      typeof namespaceOrChainId === "string"
        ? namespaceOrChainId
        : this.namespaceOf(namespaceOrChainId);
    const ns = this.state[namespace];

    if ("address" in update) {
      // A namespace changing hands is what the generation tracks. Doing it
      // here covers every claiming path: connect(), the public
      // syncWalletState() an integration calls, and the EIP-1193 listeners.
      //
      // Only a CHANGE counts. Re-writing the same wallet (a chain switch, a
      // re-confirmation) must not bump, or a legitimate disconnect that raced
      // one would decide it was stale and leave the state behind.
      ns.address = update.address;
    }

    if ("chainId" in update) {
      ns.chainId = update.chainId;
    } else if (typeof namespaceOrChainId === "number") {
      ns.chainId = namespaceOrChainId;
    }

    if (namespace === "evm" && "provider" in update) {
      this.displaceProvider(
        (ns as EvmChainState).provider,
        update.provider
      );
      (ns as EvmChainState).provider = update.provider;
    }

    this._activeNamespace = namespace;
    this.syncDerived();
  }

  /** Wipe a namespace. Per-namespace so a Solana disconnect spares EVM. */
  clear(namespaceOrChainId: ChainNamespace | ChainID | undefined): void {
    const namespace =
      typeof namespaceOrChainId === "string"
        ? namespaceOrChainId
        : this.namespaceOf(namespaceOrChainId);
    if (namespace === "evm") {
      // Wiping the namespace drops the active provider with it.
      this.displaceProvider(this.state.evm.provider, undefined);
      this.state.evm = {};
    } else {
      this.state.solana = {};
    }
    this.syncDerived();
  }

  /** Both namespaces, keeping the EVM provider so tracking can resume. */
  reset(): void {
    const evmProvider = this.state.evm.provider;
    this.state = { evm: { provider: evmProvider }, solana: {} };
    this._activeNamespace = undefined;
    this.address = undefined;
    this.chainId = undefined;
  }

  /** Drop the active provider without touching identity. */
  clearProvider(): void {
    this.provider = undefined;
  }

  /**
   * Repoint the active identity at a wallet, as `identify(setActive)` does,
   * without disturbing per-namespace chain state.
   *
   * Deliberately transient. The next wallet event for either namespace
   * re-derives from namespace state and replaces this, which is the intended
   * order: a wallet that actually connects outranks one merely named by
   * `identify()`. The alternative, making an identify sticky until another
   * identify, would silently mis-attribute every event after a connect.
   */
  setActiveAddress(address: Address | undefined): void {
    this.address = address;
    this.persist();
  }

  /** Repoint (or forget) the derived chain while keeping the wallet. */
  setActiveChainId(chainId: ChainID | undefined): void {
    this.chainId = chainId;
    this.persist();
  }

  /** Forget the derived chain while keeping the wallet. */
  clearActiveChainId(): void {
    this.setActiveChainId(undefined);
  }

  // ── higher-level operations ──────────────────────────────────────────────

  /**
   * Record validated wallet/chain state WITHOUT emitting an event.
   *
   * Integrations (the wagmi handler among them) must call this on every
   * connect / chain change / disconnect, even when the matching autocapture
   * event is disabled. Otherwise `chainId` stays stale and the exclusion gate,
   * which keys off it rather than the event payload, can be bypassed.
   */
  syncWalletState(params: { chainId?: ChainID; address?: Address }): void {
    const { chainId, address } = params;

    // An integration adopting or dropping a wallet is a wallet signal like
    // any other, so it takes its place in the order. Without this, a
    // disconnect still in flight could not tell that the wagmi handler had
    // already adopted a replacement.
    this.observe(this.namespaceOf(chainId));

    if (this.deps.isTrackingSuppressed()) {
      // While suppressed we must never LEARN a new wallet, but we must still
      // CLEAR a stale one. Otherwise a disconnect or switch observed on a
      // suppressed route leaves the previous address in memory and in the
      // cookie, ready to attach to later allowed-page events.
      if (!address) {
        this.clearForChain(chainId);
        return;
      }
      if (chainId === null || chainId === undefined) return;
      const namespace = this.namespaceOf(chainId);
      const known = this.state[namespace].address;
      const incoming = validateAddress(address, chainId);
      if (known && incoming && incoming !== known) {
        // A switch away from the learned wallet invalidates it. Drop the
        // stale one without learning the new address.
        this.clear(chainId);
      }
      return;
    }

    if (!address) {
      this.clearForChain(chainId);
      return;
    }
    if (chainId === null || chainId === undefined) return;

    const valid = validateAddress(address, chainId);
    if (!valid) {
      logger.warn(
        `syncWalletState: invalid address ("${address}") for chain ${chainId}`
      );
      return;
    }
    this.set(chainId, { address: valid });
  }

  /**
   * Learn an EVM wallet observed on an autocaptured signature or transaction,
   * when nothing is known yet.
   *
   * Deliberately conservative: it never overwrites a different wallet, and it
   * corrects only a stale chain for the wallet already known.
   */
  backfill(
    address: Address,
    chainId?: ChainID,
    provider?: EIP1193Provider
  ): void {
    // Refuse a chain the provider has since moved off.
    //
    // A request captures its chain once and reuses that snapshot for every
    // status it emits, which is right for the payload: a confirmation must
    // not be relabelled mid-flight. Writing that captured value back into
    // central state on a LATER status restored a chain the wallet had already
    // left, and the unscoped events that fall back to it then bypassed an
    // exclusion that should have caught them.
    if (provider && chainId !== undefined && chainId !== 0) {
      const live = this.deps.providerChainId(provider);
      if (live !== undefined && live !== chainId) chainId = live;
    }

    // `0` is kept deliberately. It means "could not resolve", and persisting
    // it is what lets the exclusion gate refuse the unscoped events (page,
    // track, identify) that carry no chain of their own. Erasing it to
    // `undefined` looked tidier but removed the only marker distinguishing
    // "unknown" from "no wallet yet".

    // Never learn identity while suppressed. A signature observed on an
    // excluded route must not populate the address for later allowed pages.
    if (this.deps.isTrackingSuppressed()) return;

    const known = this.evmAddress;
    if (known) {
      // Same wallet, newer chain: correct it rather than returning. A
      // persisted wallet restores a chain from a previous session, and if the
      // provider has since moved, the stale restored chain would stay in the
      // derived value and carry the unscoped events past an exclusion.
      if (
        chainId !== undefined &&
        known.toLowerCase() === address.toLowerCase() &&
        this.evmChainId !== chainId
      ) {
        this.set("evm", { address: known, chainId });
      }
      // A DIFFERENT address is another wallet's business; never overwrite.
      return;
    }

    this.set("evm", { address, chainId });
  }

  /**
   * Apply an EVM connect/switch seen while tracking is suppressed: never
   * learn the wallet, but if it is a switch away from one already learned,
   * drop the stale one so it cannot attach to a later allowed-page event.
   */
  clearStaleEvmWalletOnSwitchWhileSuppressed(address: string): void {
    const known = this.state.evm.address;
    const incoming = validateAndChecksumAddress(address);
    if (known && incoming && incoming !== known) this.clear("evm");
  }

  // ── persistence ──────────────────────────────────────────────────────────

  /**
   * Persist (or clear) the wallet snapshot, so the next page load can
   * repopulate identity before the wallet reconnects. Without it, every
   * `track()` / `page()` between page-show and reconnection ships with no
   * address.
   */
  persist(): void {
    try {
      // Visitor-level suppression is stable for the session, so purging is
      // safe and prevents a stale snapshot outliving an opt-out.
      if (this.deps.isPersistedIdentityPurgeRequired()) {
        cookie().remove(ACTIVE_WALLET_KEY);
        return;
      }
      if (this.address) {
        // Page-level exclusion: do not write while on an excluded route, but
        // leave any existing cookie alone. One written on an allowed page
        // must survive a transient visit here.
        if (this.deps.isPageExcluded()) return;
        const value = JSON.stringify({
          address: this.address,
          ...(this.chainId !== undefined && { chainId: this.chainId }),
        });
        const domain = getIdentityCookieDomain(this.deps.crossSubdomainCookies());
        cookie().set(ACTIVE_WALLET_KEY, value, {
          path: "/",
          expires: new Date(Date.now() + ACTIVE_WALLET_TTL_MS).toUTCString(),
          ...getIdentityCookieSecurity(),
          ...(domain ? { domain } : {}),
        });
      } else {
        // No active wallet: clear the snapshot. This runs even on an excluded
        // route, so a disconnect observed while suppressed actively removes
        // stale identity rather than leaving it for later.
        cookie().remove(ACTIVE_WALLET_KEY);
      }
    } catch (err) {
      logger.warn("Failed to persist current wallet snapshot", err);
    }
  }

  /** Seed identity from the persisted snapshot, once, during construction. */
  load(): void {
    try {
      if (this.deps.isPersistedIdentityPurgeRequired()) {
        cookie().remove(ACTIVE_WALLET_KEY);
        return;
      }
      // Page-level exclusion: don't restore into memory here, but keep the
      // cookie so a later allowed-page load can.
      if (this.deps.isPageExcluded()) return;

      const raw = cookie().get(ACTIVE_WALLET_KEY) as string | undefined;
      if (!raw) return;
      const parsed = JSON.parse(raw) as { address?: string; chainId?: unknown };
      if (!parsed?.address) return;

      // A cookie is attacker-writable and survives across SDK versions, so
      // the chain has to be a real number before anything trusts it. A string
      // "137" restored as-is would never match a numeric exclusion list, so
      // an excluded chain would silently start reporting again.
      //
      // A present-but-unusable chain rejects the WHOLE snapshot rather than
      // being downgraded to "chainless". Downgrading looks harmless and is
      // not: the namespace is derived from the chain, so a Solana wallet with
      // a corrupt chain would be filed under EVM, and a later Solana
      // disconnect would fall through to that phantom entry and keep
      // attributing events to a wallet that had gone.
      const rawChain: unknown = parsed.chainId;
      const chainMissing = rawChain === undefined || rawChain === null;
      if (
        !chainMissing &&
        (typeof rawChain !== "number" || !Number.isFinite(rawChain))
      ) {
        cookie().remove(ACTIVE_WALLET_KEY);
        return;
      }
      const chainId = chainMissing ? undefined : (rawChain as ChainID);

      const namespace = this.namespaceOf(chainId);
      const validated = validateAddress(parsed.address, chainId);
      if (!validated) {
        cookie().remove(ACTIVE_WALLET_KEY);
        return;
      }
      const ns = this.state[namespace];
      ns.address = validated;
      if (chainId !== undefined) ns.chainId = chainId;
      this._activeNamespace = namespace;
      this.address = validated;
      this.chainId = chainId;
    } catch (err) {
      logger.warn("Failed to restore persisted wallet snapshot", err);
      cookie().remove(ACTIVE_WALLET_KEY);
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  private clearForChain(chainId?: ChainID): void {
    if (chainId !== undefined && chainId !== null) {
      this.clear(chainId);
    } else {
      this.clear("evm");
      this.clear("solana");
    }
  }

  private displaceProvider(
    previous: EIP1193Provider | undefined,
    next: EIP1193Provider | undefined
  ): void {
    if (previous && previous !== next) this.deps.onProviderDisplaced(previous);
  }

  /**
   * Re-derive `address`/`chainId` from the active namespace.
   *
   * Last-connected wins, then fall through to the other namespace so a
   * still-connected wallet keeps attribution when its neighbour disconnects.
   */
  private syncDerived(): void {
    const active = this._activeNamespace;
    if (active) {
      const state = this.state[active];
      if (state.address || state.chainId) {
        this.address = state.address;
        this.chainId = state.chainId;
        this.persist();
        return;
      }
    }
    const other: ChainNamespace = active === "evm" ? "solana" : "evm";
    const otherState = this.state[other];
    if (otherState.address || otherState.chainId) {
      this.address = otherState.address;
      this.chainId = otherState.chainId;
      this._activeNamespace = other;
      this.persist();
      return;
    }
    this.address = undefined;
    this.chainId = undefined;
    this.persist();
  }
}
