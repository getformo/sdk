/**
 * SolanaWalletStandardRegistry
 *
 * Which Solana wallets exist, and whether each is connected. The Solana
 * analogue of `EvmProviderRegistry` + EIP-6963.
 *
 * Every modern Solana wallet (Phantom, Solflare, Backpack, ...) announces
 * itself through the Wallet Standard's window-event handshake, and
 * `@solana/wallet-adapter`, framework-kit, Privy, Dynamic and Reown all sit
 * on top of that same handshake. Observing it here therefore covers every
 * wallet library at once, with no configuration from the host app: the
 * registry announces `wallet-standard:app-ready`, listens for
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
import type { AutocaptureEventType } from "../tracking/TrackingPolicy";
import { isBlockedSolanaAddress, isSolanaAddress } from "./address";
import {
  DEFAULT_SOLANA_CHAIN_ID,
  SOLANA_CHAIN_IDS,
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
export interface SolanaWalletStandardRegistryDeps {
  isAutocaptureEnabled(eventType: AutocaptureEventType): boolean;
  detect(params: { providerName: string; rdns: string }): Promise<void>;
  connect(
    params: { chainId: number; address: string },
    properties: { providerName: string; rdns: string }
  ): Promise<void>;
  disconnect(params: { chainId: number; address: string }): Promise<void>;
  chain(params: { chainId: number; address: string }): Promise<void>;
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

interface TrackedWallet {
  wallet: WalletStandardWallet;
  name: string;
  rdns: string;
  /** Unsubscribe from `standard:events`, when the wallet offers it. */
  unsubscribe?: UnsubscribeFn;
  /** The account this registry currently considers connected, if any. */
  connected?: { address: string; chainId: number };
  /** Whether this registry, rather than a store, emitted its connect. */
  connectWasReported: boolean;
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
      // The store handler reports this connection. Still record it, so a
      // later change is judged against what the wallet actually did rather
      // than against a stale snapshot.
      tracked.connected = next
        ? { address: next.address, chainId: this.chainIdFor(tracked) }
        : undefined;
      tracked.connectWasReported = false;
      return;
    }

    if (previous) this.reportDisconnect(tracked, previous);
    if (next) this.reportConnect(tracked, next.address);
  }

  private reportConnect(tracked: TrackedWallet, address: string): void {
    const chainId = this.chainIdFor(tracked);
    tracked.connected = { address, chainId };
    tracked.connectWasReported = false;

    logger.info("SolanaWalletStandardRegistry: Wallet connected", {
      name: tracked.name,
      address,
      chainId,
    });

    if (!this.deps.isAutocaptureEnabled("connect")) return;
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

    logger.info("SolanaWalletStandardRegistry: Wallet disconnected", {
      name: tracked.name,
      address: previous.address,
      chainId: previous.chainId,
    });

    if (!this.deps.isAutocaptureEnabled("disconnect")) return;
    this.deps.disconnect(previous).catch((error) => {
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

    for (const tracked of Array.from(this.wallets.values())) {
      const connected = tracked.connected;
      if (!connected || connected.chainId === chainId) continue;
      tracked.connected = { address: connected.address, chainId };
      if (!this.deps.ownsWalletEvents()) continue;
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

  /** The first connected wallet's account, if any. */
  get connectedAccount(): { address: string; chainId: number } | undefined {
    for (const tracked of Array.from(this.wallets.values())) {
      if (tracked.connected) return tracked.connected;
    }
    return undefined;
  }

  /**
   * Transfer a connect already emitted by this registry to a store handler.
   * The state remains connected, but the same transition must not be emitted
   * a second time when framework-kit's store catches up.
   */
  takeReportedConnection(
    address: string
  ): { address: string; chainId: number } | undefined {
    for (const tracked of Array.from(this.wallets.values())) {
      if (
        tracked.connectWasReported &&
        tracked.connected?.address === address
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
