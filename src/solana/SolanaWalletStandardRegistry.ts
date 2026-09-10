/**
 * SolanaWalletStandardRegistry
 *
 * Which Solana wallets exist, and whether each is connected. The Solana
 * analogue of `EvmProviderRegistry` + EIP-6963.
 *
 * Compatible wallets (Phantom, Solflare, Backpack, ...) announce themselves
 * through the Wallet Standard's window-event handshake. Solana Kit,
 * wallet-adapter, and framework-kit use these registered wallets. Observing
 * the handshake covers those wallets without coupling Formo to the host
 * library: the registry announces `wallet-standard:app-ready`, listens for
 * `wallet-standard:register-wallet`, and subscribes to each wallet's
 * `standard:events` `change` event.
 *
 * What it reports:
 *  - `detect` when a wallet registers (session-deduped by the SDK on rdns).
 *  - `connect` when a wallet's Solana accounts go from none to some, or the
 *    first account changes; `disconnect` when they go from some to none.
 *  - `chain` when the configured cluster changes while a wallet is connected.
 *
 * What it does not do: wrap any wallet method, issue any request to a
 * wallet, or depend on `@wallet-standard/*` (the handshake is a few lines,
 * and the SDK's dependency policy is two runtime dependencies, forever).
 *
 * Cluster: the Wallet Standard lists every cluster a wallet SUPPORTS, not
 * the one the app is using, so the cluster is `options.solana.cluster` when
 * given, else mainnet-beta when the wallet supports it, else the first
 * Solana cluster it lists. A framework-kit app gets the cluster from its
 * store instead, through `SolanaStoreHandler`.
 *
 * @see https://github.com/wallet-standard/wallet-standard
 */

import { logger } from "../logger";
import { isBlockedSolanaAddress, isSolanaAddress } from "./address";
import {
  DEFAULT_SOLANA_CHAIN_ID,
  SOLANA_CHAIN_IDS,
  SolanaCaptureDeps,
  SolanaCluster,
  UnsubscribeFn,
  solanaWalletRdns,
} from "./types";
import {
  WALLET_STANDARD_APP_READY_EVENT,
  WALLET_STANDARD_EVENTS_FEATURE,
  WALLET_STANDARD_REGISTER_WALLET_EVENT,
  WalletStandardAccount,
  WalletStandardChangeProperties,
  WalletStandardEventsFeature,
  WalletStandardRegisterApi,
  WalletStandardWallet,
} from "./walletStandardTypes";

const SOLANA_CHAIN_PREFIX = "solana:";

/** Wallet Standard chain identifiers, keyed to Formo cluster names. */
const CLUSTER_BY_CHAIN: Record<string, SolanaCluster> = {
  "solana:mainnet": "mainnet-beta",
  "solana:devnet": "devnet",
  "solana:testnet": "testnet",
  "solana:localnet": "localnet",
};

/** What the registry needs from the SDK that owns it. */
export interface SolanaWalletStandardRegistryDeps extends SolanaCaptureDeps {
  willTrackEvent(chainId: number): boolean;
  detect(params: { providerName: string; rdns: string }): Promise<void>;
  /**
   * Record wallet and chain state centrally WITHOUT emitting an event.
   *
   * Observing a wallet is not the same as reporting one: the exclusion gate
   * keys off the central chain, so a connection or a cluster switch has to
   * land there even when the matching autocapture event is off or the chain
   * is excluded. Without an address, the chain's state is cleared. The EVM
   * tracker separates the two the same way.
   * @see FormoAnalytics.syncWalletState
   */
  syncWalletState(params: { chainId: number; address?: string }): void;
  /** The wallet the SDK currently treats as active, across namespaces. */
  currentAddress(): string | undefined;
  /**
   * Whether THIS registry reports connections.
   *
   * A framework-kit app connects through the very same Wallet Standard
   * wallet, so its store and this registry both see every connection. The
   * store is the better witness there (it knows the cluster and connector),
   * so once it has observed or adopted a connection the registry keeps
   * discovering wallets and emitting `detect`, but leaves connect and
   * disconnect to the store. Exactly one connect per connection, either way.
   */
  ownsWalletEvents(): boolean;
}

export interface SolanaWalletStandardRegistryOptions {
  /** The cluster the app uses. Overrides what is derived from the wallet. */
  cluster?: SolanaCluster;
}

type SolanaConnection = { address: string; chainId: number };

interface TrackedWallet {
  wallet: WalletStandardWallet;
  name: string;
  rdns: string;
  /** Unsubscribe from `standard:events`, when the wallet offers it. */
  unsubscribe?: UnsubscribeFn;
  /** The account this registry currently considers connected, if any. */
  connected?: { address: string; chainId: number };
  /** Order of connection, so the newest remaining wallet can take the slot. */
  connectedSeq?: number;
  /** Whether this registry, rather than a store, emitted its connect. */
  connectWasReported: boolean;
  /**
   * Whether the connection reached central state through this registry. A
   * connection recorded while a store owned events, or observed while
   * suppressed, has no connect event and must not be put back.
   */
  attributed: boolean;
}

/** Whether a chain identifier belongs to the Solana namespace. */
function isSolanaChain(chain: unknown): chain is string {
  return typeof chain === "string" && chain.startsWith(SOLANA_CHAIN_PREFIX);
}

/**
 * Accept only what looks like a Wallet Standard wallet that speaks Solana.
 *
 * A multichain wallet may register once and list Solana beside other
 * namespaces; that is fine. A wallet that lists no Solana chain at all is
 * not ours to track.
 */
function asSolanaWallet(candidate: unknown): WalletStandardWallet | undefined {
  if (!candidate || typeof candidate !== "object") return undefined;
  const wallet = candidate as Partial<WalletStandardWallet>;
  if (typeof wallet.name !== "string" || !wallet.name) return undefined;
  if (!Array.isArray(wallet.chains) || !wallet.chains.some(isSolanaChain)) {
    return undefined;
  }
  if (!wallet.features || typeof wallet.features !== "object") return undefined;
  if (!Array.isArray(wallet.accounts)) return undefined;
  return wallet as WalletStandardWallet;
}

/**
 * The first account that is a Solana wallet account, or undefined.
 *
 * An account declares the chains it signs for. On a multichain wallet the
 * list can hold an EVM account beside a Solana one, and the SDK's connect
 * validates the address against the chain id, so only a Solana account may
 * be reported under a Solana chain id. An account with no chain list is
 * judged on its address alone.
 */
function firstSolanaAccount(
  accounts: readonly unknown[]
): WalletStandardAccount | undefined {
  for (const candidate of accounts) {
    if (!candidate || typeof candidate !== "object") continue;
    const account = candidate as WalletStandardAccount;
    if (Array.isArray(account.chains) && !account.chains.some(isSolanaChain)) {
      continue;
    }
    if (!isSolanaAddress(account.address)) continue;
    if (isBlockedSolanaAddress(account.address)) continue;
    return account;
  }
  return undefined;
}

export class SolanaWalletStandardRegistry {
  private wallets = new Map<WalletStandardWallet, TrackedWallet>();
  private connectSeq = 0;
  /**
   * Connections observed before this sequence number predate a `reset()`.
   * They stay tracked and their disconnect is still reported, but they are
   * not put back into central state until observed again: reset() promised
   * a clean slate.
   */
  private restorableFrom = 0;
  private cluster?: SolanaCluster;
  private removeWindowListener?: () => void;
  /** Set by cleanup(); a torn-down registry refuses late registrations. */
  private isCleanedUp = false;
  /**
   * Handed to every wallet. Wallets keep it and may call `register` long
   * after the handshake, which is why `register` checks `isCleanedUp`.
   */
  private readonly api: WalletStandardRegisterApi;

  constructor(
    private readonly deps: SolanaWalletStandardRegistryDeps,
    options?: SolanaWalletStandardRegistryOptions
  ) {
    this.cluster = options?.cluster;
    this.api = Object.freeze({
      register: (...wallets: WalletStandardWallet[]) =>
        this.register(...wallets),
    });
    this.listen();
  }

  // ── discovery ───────────────────────────────────────────────────────────

  /**
   * The Wallet Standard handshake, both directions.
   *
   * A wallet injected before us hears `app-ready` and registers at once; a
   * wallet injected after us dispatches `register-wallet`, which we answer.
   * Neither is optional: an extension's content script and the app's bundle
   * race, and which one wins differs per page load.
   */
  private listen(): void {
    if (
      typeof window === "undefined" ||
      typeof window.addEventListener !== "function"
    ) {
      return;
    }

    const onRegisterWallet = (event: Event): void => {
      const callback = (event as { detail?: unknown }).detail;
      if (typeof callback !== "function") return;
      try {
        callback(this.api);
      } catch (error) {
        logger.warn(
          "SolanaWalletStandardRegistry: A wallet threw while registering",
          error
        );
      }
    };

    try {
      window.addEventListener(
        WALLET_STANDARD_REGISTER_WALLET_EVENT,
        onRegisterWallet
      );
      this.removeWindowListener = () =>
        window.removeEventListener(
          WALLET_STANDARD_REGISTER_WALLET_EVENT,
          onRegisterWallet
        );
    } catch (error) {
      logger.warn(
        "SolanaWalletStandardRegistry: Could not listen for wallet registrations",
        error
      );
    }

    if (typeof CustomEvent !== "function") return;
    try {
      window.dispatchEvent(
        new CustomEvent(WALLET_STANDARD_APP_READY_EVENT, { detail: this.api })
      );
    } catch (error) {
      logger.warn(
        "SolanaWalletStandardRegistry: Could not announce app-ready",
        error
      );
    }
  }

  /**
   * Add wallets once. Returns an unregister function, as the standard asks.
   *
   * Public so an integration that already holds a wallet object (its own
   * `getWallets()` call, say) can hand it over without the window handshake.
   */
  register(...wallets: unknown[]): UnsubscribeFn {
    const added: TrackedWallet[] = [];
    if (this.isCleanedUp) return () => undefined;

    for (const candidate of wallets) {
      const wallet = asSolanaWallet(candidate);
      if (!wallet || this.wallets.has(wallet)) continue;
      const tracked: TrackedWallet = {
        wallet,
        name: wallet.name,
        rdns: solanaWalletRdns(wallet.name),
        connectWasReported: false,
        attributed: false,
      };
      this.wallets.set(wallet, tracked);
      added.push(tracked);
      this.track(tracked);
    }

    return () => {
      for (const tracked of added) this.untrack(tracked);
    };
  }

  private track(tracked: TrackedWallet): void {
    logger.info("SolanaWalletStandardRegistry: Discovered wallet", {
      name: tracked.name,
      chains: tracked.wallet.chains,
    });

    // A wallet already authorized moves the central chain first, so the
    // detect gate reads the live cluster and not a snapshot on an excluded one.
    const live = firstSolanaAccount(tracked.wallet.accounts);
    if (live && this.deps.ownsWalletEvents()) {
      this.deps.syncWalletState({ chainId: this.chainIdFor(tracked), address: live.address });
    }

    this.deps
      .detect({ providerName: tracked.name, rdns: tracked.rdns })
      .catch((error) => {
        logger.error(
          "SolanaWalletStandardRegistry: Error emitting detect",
          error
        );
      });

    const events = tracked.wallet.features[WALLET_STANDARD_EVENTS_FEATURE] as
      | Partial<WalletStandardEventsFeature>
      | undefined;
    if (events && typeof events.on === "function") {
      try {
        tracked.unsubscribe = events.on("change", (properties) =>
          this.onChange(tracked, properties)
        );
      } catch (error) {
        logger.warn(
          `SolanaWalletStandardRegistry: Could not subscribe to ${tracked.name} events`,
          error
        );
      }
    } else {
      logger.info(
        `SolanaWalletStandardRegistry: ${tracked.name} has no standard:events feature; connections cannot be observed`
      );
    }

    // A wallet that is already authorized when we first see it (the app
    // connected before the SDK initialised, or the wallet restored a trusted
    // session on load) will never fire a change event for that connection.
    this.reconcile(tracked, tracked.wallet.accounts);
  }

  private untrack(tracked: TrackedWallet): void {
    try {
      tracked.unsubscribe?.();
    } catch (error) {
      logger.warn(
        `SolanaWalletStandardRegistry: Could not unsubscribe from ${tracked.name}`,
        error
      );
    }
    tracked.unsubscribe = undefined;
    this.wallets.delete(tracked.wallet);
  }

  // ── connection state ────────────────────────────────────────────────────

  private onChange(
    tracked: TrackedWallet,
    properties: WalletStandardChangeProperties | undefined
  ): void {
    if (this.isCleanedUp) return;
    // `change` carries only what changed. A wallet that omits `accounts` is
    // reporting something else (chains, features); the wallet's own
    // `accounts` is the ground truth either way, so read that when the
    // event does not say.
    const accounts = Array.isArray(properties?.accounts)
      ? properties.accounts
      : tracked.wallet.accounts;
    this.reconcile(tracked, Array.isArray(accounts) ? accounts : []);
  }

  /**
   * Compare what the wallet now authorizes with what was last reported.
   *
   * none → some is a connect, some → none a disconnect, and a different
   * first account is a disconnect followed by a connect, matching what the
   * framework-kit store handler reports for the same transitions.
   */
  private reconcile(
    tracked: TrackedWallet,
    accounts: readonly unknown[]
  ): void {
    const next = firstSolanaAccount(accounts);
    const previous = tracked.connected;

    if (!previous && !next) return;
    if (previous && next && previous.address === next.address) return;

    if (!this.deps.ownsWalletEvents()) {
      // A connection this registry reported before a store took ownership
      // is one the store cannot see end; close it here so its connect is
      // not left open forever.
      if (previous && tracked.connectWasReported) {
        this.reportDisconnect(tracked, previous);
      }
      // The store handler reports the rest. Still record it, so a later
      // change is judged against what the wallet actually did rather than
      // against a stale snapshot.
      tracked.connected = next
        ? { address: next.address, chainId: this.chainIdFor(tracked) }
        : undefined;
      if (next) tracked.connectedSeq = ++this.connectSeq;
      tracked.connectWasReported = false;
      tracked.attributed = false;
      return;
    }

    if (previous) this.reportDisconnect(tracked, previous);
    if (next) this.reportConnect(tracked, next.address);
  }

  private reportConnect(tracked: TrackedWallet, address: string): void {
    const chainId = this.chainIdFor(tracked);
    tracked.connected = { address, chainId };
    tracked.connectedSeq = ++this.connectSeq;
    tracked.connectWasReported = false;

    logger.info("SolanaWalletStandardRegistry: Wallet connected", {
      name: tracked.name,
      address,
      chainId,
    });

    // Exclusion is not suppression: the connection lands centrally either way.
    this.deps.syncWalletState({ chainId, address });
    // Restorable only if central state accepted it. While the visitor is
    // suppressed nothing is learned, and a connection observed then must not
    // come back through a later hand-off once tracking resumes.
    tracked.attributed = this.deps.solanaAddress() === address;

    if (!this.deps.isAutocaptureEnabled("connect")) return;
    // FormoAnalytics.connect() deliberately resolves without enqueueing when
    // tracking is suppressed or this chain is excluded. Only a connect that
    // can actually be accepted may suppress the authoritative store event
    // that can follow.
    if (!this.deps.willTrackEvent(chainId)) return;
    tracked.connectWasReported = true;
    this.deps
      .connect(
        { chainId, address },
        { providerName: tracked.name, rdns: tracked.rdns }
      )
      .catch((error) => {
        logger.error(
          "SolanaWalletStandardRegistry: Error emitting connect",
          error
        );
      });
  }

  private reportDisconnect(
    tracked: TrackedWallet,
    previous: { address: string; chainId: number }
  ): void {
    tracked.connected = undefined;
    tracked.connectWasReported = false;
    tracked.attributed = false;

    logger.info("SolanaWalletStandardRegistry: Wallet disconnected", {
      name: tracked.name,
      address: previous.address,
      chainId: previous.chainId,
    });

    if (!this.deps.isAutocaptureEnabled("disconnect")) {
      // Keep central state honest, as `disconnect()` would have. Another
      // wallet holding the slot is not ours to touch. Otherwise clear the
      // departed wallet (a restore is a no-op while suppressed), then hand
      // the slot to the newest remaining connection.
      const held = this.deps.solanaAddress();
      if (held && held !== previous.address) return;
      this.deps.syncWalletState({ chainId: previous.chainId });
      const remaining = this.newestConnection();
      if (remaining) this.deps.restoreWalletState(remaining);
      return;
    }
    // `disconnect()` clears the Solana namespace once the event is built.
    // Put the slot back afterwards: to the wallet that held it, else to the
    // newest remaining one, the same as the capture-off path. A store's
    // wallet is the store's to restore (see SolanaManager).
    const held = this.deps.solanaAddress();
    // Taken before the await: a reset() or a new session landing meanwhile
    // makes the restore stale, and only the SDK can tell.
    const restore = this.deps.deferWalletRestore(previous.chainId);
    this.deps
      .disconnect(previous)
      .then(() => {
        if (this.deps.solanaAddress()) return;
        // The wallet that held the slot, if tracked here (possibly on the
        // same address), else the newest remaining one.
        // A slot held by another wallet goes back to that wallet only, if it
        // is tracked here; a holder this registry does not know (a manual
        // connect, a store's wallet) is not replaced by an unrelated wallet.
        const owner =
          held && held !== previous.address
            ? this.connectionOf(held)
            : this.connectionOf(previous.address) ?? this.newestConnection(previous.address);
        if (owner) restore(owner);
      })
      .catch((error) => {
        logger.error(
          "SolanaWalletStandardRegistry: Error emitting disconnect",
          error
        );
      });
  }

  // ── cluster ─────────────────────────────────────────────────────────────

  /**
   * The chain id to report for a wallet.
   *
   * The Wallet Standard cannot say which cluster the app is on, only which
   * ones the wallet supports, so an explicit cluster wins, then mainnet-beta
   * if supported (nearly every wallet lists every cluster, and production
   * traffic is mainnet), then the first cluster listed.
   */
  private chainIdFor(tracked: TrackedWallet): number {
    if (this.cluster) return SOLANA_CHAIN_IDS[this.cluster];
    const chains = tracked.wallet.chains;
    if (chains.includes("solana:mainnet")) return DEFAULT_SOLANA_CHAIN_ID;
    for (const chain of chains) {
      const cluster = CLUSTER_BY_CHAIN[chain];
      if (cluster) return SOLANA_CHAIN_IDS[cluster];
    }
    return DEFAULT_SOLANA_CHAIN_ID;
  }

  /**
   * Set the cluster the app uses. A connected wallet's chain id follows,
   * with a `chain` event, the same as the store handler on a cluster switch.
   */
  setCluster(cluster: SolanaCluster): void {
    if (this.cluster === cluster) return;
    this.cluster = cluster;
    const chainId = SOLANA_CHAIN_IDS[cluster];

    const all = Array.from(this.wallets.values());
    // Central state follows ONE wallet. Two wallets can hold an authorized
    // account at once, and writing each of them here would hand the wallet
    // slot to the last REGISTERED wallet rather than to the one the SDK
    // already treats as active, which is the last CONNECTED one.
    //
    // Only a wallet observed since the last reset() may take the slot.
    const slot = this.deps.solanaAddress() ?? this.deps.currentAddress();
    const owner = this.trackedOn(slot) ?? this.newestTracked();

    for (const tracked of all) {
      const connected = tracked.connected;
      if (!connected || connected.chainId === chainId) continue;
      tracked.connected = { address: connected.address, chainId };
      if (!this.deps.ownsWalletEvents()) continue;
      // Central state moves first, so a suppressed chain event still leaves
      // the SDK on the cluster the wallet is actually on. `chain()` writes
      // the cluster itself, but only when the event is not suppressed.
      if (tracked === owner) {
        this.deps.restoreWalletState({ chainId, address: connected.address });
      }
      if (!this.deps.isAutocaptureEnabled("chain")) continue;
      this.deps
        .chain({ chainId, address: connected.address })
        .catch((error) => {
          logger.error(
            "SolanaWalletStandardRegistry: Error emitting chain event",
            error
          );
        });
    }
  }

  // ── introspection ───────────────────────────────────────────────────────

  /** Names of every wallet discovered so far, for the debug helpers. */
  get walletNames(): string[] {
    return Array.from(this.wallets.values()).map((t) => t.name);
  }

  /** The newest restorable connection, if any, other than `except`. */
  newestConnection(except?: string): SolanaConnection | undefined {
    return this.newestTracked(except)?.connected;
  }

  /** The restorable connection on `address`, if any. */
  private connectionOf(address: string | undefined): SolanaConnection | undefined {
    return this.trackedOn(address)?.connected;
  }

  private newestTracked(except?: string): TrackedWallet | undefined {
    let newest: TrackedWallet | undefined;
    this.wallets.forEach((candidate) => {
      if (!this.isRestorable(candidate) || candidate.connected?.address === except) return;
      if ((candidate.connectedSeq ?? 0) > (newest?.connectedSeq ?? -1)) newest = candidate;
    });
    return newest;
  }

  private trackedOn(address: string | undefined): TrackedWallet | undefined {
    if (!address) return undefined;
    for (const candidate of Array.from(this.wallets.values())) {
      if (this.isRestorable(candidate) && candidate.connected?.address === address) return candidate;
    }
    return undefined;
  }

  /** Live, attributed, and observed since the last reset(). */
  private isRestorable(candidate: TrackedWallet): boolean {
    return (
      !!candidate.connected &&
      candidate.attributed &&
      (candidate.connectedSeq ?? 0) >= this.restorableFrom
    );
  }

  /** @see restorableFrom */
  onReset(): void {
    this.restorableFrom = this.connectSeq + 1;
  }

  /**
   * The rdns this registry reported a still-live connect for `address`
   * under, if any. Lets a failed store adoption name both identities.
   */
  reportedConnectionRdns(address: string): string | undefined {
    for (const tracked of Array.from(this.wallets.values())) {
      if (
        tracked.connectWasReported &&
        tracked.connected?.address === address
      ) {
        return tracked.rdns;
      }
    }
    return undefined;
  }

  /**
   * Transfer a connect already emitted by this registry to a store handler.
   * The state remains connected, but the same transition must not be emitted
   * a second time when framework-kit's store catches up.
   */
  takeReportedConnection(
    address: string,
    rdns: string
  ): { address: string; chainId: number } | undefined {
    for (const tracked of Array.from(this.wallets.values())) {
      if (
        tracked.connectWasReported &&
        tracked.connected?.address === address &&
        tracked.rdns === rdns
      ) {
        tracked.connectWasReported = false;
        return tracked.connected;
      }
    }
    return undefined;
  }

  // ── teardown ────────────────────────────────────────────────────────────

  cleanup(): void {
    this.isCleanedUp = true;
    try {
      this.removeWindowListener?.();
    } catch (error) {
      logger.warn(
        "SolanaWalletStandardRegistry: Could not remove window listener",
        error
      );
    }
    this.removeWindowListener = undefined;
    for (const tracked of Array.from(this.wallets.values())) {
      this.untrack(tracked);
    }
    this.wallets.clear();
    logger.debug("SolanaWalletStandardRegistry: Cleanup complete");
  }
}
