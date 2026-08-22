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
   * Monotonic generation per namespace, bumped whenever a namespace changes
   * hands.
   *
   * Address and provider alone cannot tell "this session never changed" apart
   * from "the same wallet disconnected and reconnected", because both leave
   * identical state. The generation can, which is what lets a slow disconnect
   * know it is stale. Kept per namespace rather than per provider so it
   * covers Solana, which has no EIP-1193 provider to hang a stamp on.
   */
  private seq: Record<ChainNamespace, number> = { evm: 0, solana: 0 };

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

  /** The current generation of a namespace. See `seq`. */
  generation(namespace: ChainNamespace): number {
    return this.seq[namespace];
  }

  /**
   * Record that a wallet has claimed a namespace, without touching state.
   *
   * `connect()` calls this because an emitted connect always means a claim,
   * even when the address it writes is the one already there: a wallet that
   * disconnects and reconnects leaves identical state, and a disconnect still
   * in flight must be able to tell that apart from nothing having happened.
   */
  claim(chainId?: ChainID): void {
    this.seq[this.namespaceOf(chainId)]++;
  }

  /** Whether a namespace changed hands since `previous` was taken. */
  hasNewSessionSince(namespace: ChainNamespace, previous: number): boolean {
    return this.seq[namespace] !== previous;
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
      const claimed =
        !!update.address && !this.isSameWallet(namespace, ns.address, update.address);
      if (claimed) this.seq[namespace]++;
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

  /**
   * Whether two addresses are the same wallet, per namespace.
   *
   * EVM addresses are hex and compare case-insensitively, so a checksummed
   * and a lowercase form are one wallet. Solana addresses are Base58, where
   * case is significant: two addresses differing only in case are DIFFERENT
   * wallets, and folding them together would let a stale disconnect target a
   * live session.
   */
  private isSameWallet(
    namespace: ChainNamespace,
    a: Address | undefined,
    b: Address
  ): boolean {
    if (!a) return false;
    return namespace === "evm" ? a.toLowerCase() === b.toLowerCase() : a === b;
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
      const chainId =
        typeof parsed.chainId === "number" && Number.isFinite(parsed.chainId)
          ? (parsed.chainId as ChainID)
          : undefined;

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
