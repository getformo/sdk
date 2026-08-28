import { EIP6963ProviderDetail } from "mipd";
import { logger } from "../logger";
import { validateAndChecksumAddress } from "../utils/address";
import { detectInjectedProviderInfo, readWalletConnectPeer } from "../provider";
import {
  Address,
  ChainID,
  EIP1193Provider,
  RPCError,
  WrappedEIP1193Provider,
  WrappedRequestFunction,
  WRAPPED_REQUEST_SYMBOL,
  WRAPPED_REQUEST_REF_SYMBOL,
} from "../types";

/** What the registry needs from the SDK that owns it. */
export interface EvmProviderRegistryDeps {
  /** The provider the SDK currently attributes activity to. */
  activeProvider(): EIP1193Provider | undefined;
  /** The active provider's chain, per central state. */
  activeChainId(): ChainID | undefined;
  /** The wallet already known for EVM, if any. */
  knownEvmAddress(): Address | undefined;
  /**
   * A provider reported a chain.
   *
   * The registry records it per provider; whether central state should follow
   * is the SDK's decision, not the registry's, because it depends on which
   * namespace is active.
   */
  onChainObserved(provider: EIP1193Provider, chainId: number): void;
}

/**
 * Which EVM wallets exist, and what is known about each.
 *
 * Split out of `FormoAnalytics` so "the provider registry" is one thing with
 * one owner. It deliberately holds no event logic: registering listeners and
 * reacting to them stays with the SDK for now, and moves next.
 *
 * Three provider sets, which are not the same thing:
 *  - `details` is every EIP-6963 provider discovered, with its metadata.
 *  - `tracked` is the subset that has listeners wired up.
 *  - `seen` guards `details` against duplicates.
 */
export class EvmProviderRegistry {
  private details: readonly EIP6963ProviderDetail[] = [];
  private tracked = new Set<EIP1193Provider>();
  private seen = new Set<EIP1193Provider>();

  /** Last chain heard from each provider, whoever is active. */
  private chainIds = new WeakMap<EIP1193Provider, number>();

  /**
   * Bumped on every chain observation, PER PROVIDER, so a stale answer that
   * arrives late cannot overwrite a newer one.
   */
  private chainGenerations = new WeakMap<EIP1193Provider, number>();

  /** Listeners this SDK attached, so teardown can remove exactly those. */
  private listeners = new Map<
    EIP1193Provider,
    Record<string, (...args: unknown[]) => void>
  >();

  /** The window-injected provider, once detected, so it is not re-wrapped. */
  private injectedDetail?: EIP6963ProviderDetail;

  /**
   * Attribution supplied by the integration layer for a provider that was
   * never announced: the wagmi fallback wrap names a connector's provider
   * after the CONNECTOR, so request-derived events carry the same wallet
   * name as the hook-driven events from the same connection. Without it
   * the name came from flag sniffing, and a custom or embedded connector
   * whose provider exposes no recognised flag split one wallet's activity
   * between "Injected Provider" and the connector's name.
   *
   * A RESOLVER, read at each `infoFor`, not a value: the name is live for
   * the connector the integration layer bound it to (a WalletConnect
   * session that resolves or changes its peer renames without a re-wrap),
   * and the integration layer names events on its hook path with the same
   * function, so the two paths cannot disagree. Which connector a
   * provider is bound to is the integration layer's decision; it is not
   * necessarily the connector that is current when the request runs.
   */
  private attributions = new WeakMap<
    EIP1193Provider,
    () => { name: string; rdns?: string } | undefined
  >();

  constructor(private readonly deps: EvmProviderRegistryDeps) {}

  // ── the provider set ─────────────────────────────────────────────────────

  get all(): readonly EIP6963ProviderDetail[] {
    return this.details;
  }

  isTracked(provider: EIP1193Provider): boolean {
    return this.tracked.has(provider);
  }

  markTracked(provider: EIP1193Provider): void {
    this.tracked.add(provider);
  }

  forgetTracked(provider: EIP1193Provider): void {
    this.tracked.delete(provider);
  }

  trackedProviders(): EIP1193Provider[] {
    return Array.from(this.tracked);
  }

  isSeen(provider: EIP1193Provider): boolean {
    return this.seen.has(provider);
  }

  get injected(): EIP6963ProviderDetail | undefined {
    return this.injectedDetail;
  }

  set injected(detail: EIP6963ProviderDetail | undefined) {
    this.injectedDetail = detail;
  }

  /** Counts for the public debug helpers. */
  get counts(): {
    totalProviders: number;
    trackedProviders: number;
    seenProviders: number;
  } {
    return {
      totalProviders: this.details.length,
      trackedProviders: this.tracked.size,
      seenProviders: this.seen.size,
    };
  }

  /** Add a discovered provider once. Returns false if already present. */
  add(detail: EIP6963ProviderDetail): boolean {
    const provider = detail?.provider as EIP1193Provider | undefined;
    if (!provider) return false;
    if (this.details.some((existing) => existing.provider === provider)) {
      return false;
    }
    this.details = [...this.details, detail];
    this.seen.add(provider);
    return true;
  }

  /**
   * Record (or, with `undefined`, forget) the integration layer's own
   * attribution resolver for a provider. See `attributions`.
   */
  rememberAttribution(
    provider: EIP1193Provider | undefined,
    resolve: (() => { name: string; rdns?: string } | undefined) | undefined
  ): void {
    if (!provider) return;
    if (!resolve) {
      this.attributions.delete(provider);
      return;
    }
    this.attributions.set(provider, resolve);
  }

  /** The supplied attribution for a provider, if any resolves right now. */
  private suppliedAttributionFor(
    provider: EIP1193Provider
  ): { name: string; rdns?: string } | undefined {
    const resolve = this.attributions.get(provider);
    if (!resolve) return undefined;
    try {
      const info = resolve();
      return info?.name ? info : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * A provider's display name and rdns.
   *
   * EIP-6963 metadata is authoritative when we have it. A supplied
   * attribution (the connector a wagmi app connected through) comes next:
   * it describes the SESSION, which is what the hook-driven events report.
   * Otherwise fall back to sniffing the injected provider, which is all a
   * pre-6963 wallet offers; a supplied name without an rdns keeps the
   * sniffed rdns.
   */
  infoFor(provider: EIP1193Provider): { name: string; rdns: string } {
    const announced = this.details.find((p) => p.provider === provider);
    const supplied = announced
      ? undefined
      : this.suppliedAttributionFor(provider);
    const info = announced
      ? { name: announced.info.name, rdns: announced.info.rdns }
      : (() => {
          const injected = detectInjectedProviderInfo(provider);
          return supplied
            ? { name: supplied.name, rdns: supplied.rdns ?? injected.rdns }
            : { name: injected.name, rdns: injected.rdns };
        })();

    // WalletConnect names the TRANSPORT; the session's peer names the
    // wallet. Resolved live, per read: a session established after the
    // provider was registered still gets its signer's name onto every
    // event from then on. Only GENERIC names are replaced - a caller who
    // registered an explicit display name keeps it. "Injected Provider"
    // is included because a flagless WalletConnect-compatible provider
    // registered BEFORE its session exists detects as nothing at all;
    // the peer appearing later is itself the proof of what it was, so
    // the rdns upgrades with it. A supplied name gets the same treatment
    // and no more: the integration layer resolves its own peer names
    // where it wants them, and a branded connector must keep its name on
    // both paths.
    if (info.name === "WalletConnect" || info.name === "Injected Provider") {
      const peer = readWalletConnectPeer(provider);
      if (peer?.name) {
        return {
          name: peer.name,
          rdns:
            info.rdns === "io.injected.provider"
              ? "com.walletconnect"
              : info.rdns,
        };
      }
    }
    return info;
  }

  // ── listener bookkeeping ─────────────────────────────────────────────────

  addListener(
    provider: EIP1193Provider,
    event: string,
    listener: (...args: unknown[]) => void
  ): void {
    const map = this.listeners.get(provider) || {};
    map[event] = listener;
    this.listeners.set(provider, map);
  }

  /** Remove only the listeners this SDK attached, never the host app's. */
  removeListeners(provider: EIP1193Provider): void {
    const attached = this.listeners.get(provider);
    if (!attached) return;

    // Keep whatever could not be removed. Forgetting a listener that is still
    // attached loses the only reference to it, so nothing can ever try again:
    // the callback stays live for the life of the page and holds the instance
    // it closes over. A provider that throws transiently during teardown gets
    // another chance on the next attempt.
    const stillAttached: Record<string, (...args: unknown[]) => void> = {};
    for (const [event, fn] of Object.entries(attached)) {
      try {
        provider.removeListener(event, fn);
      } catch (e) {
        logger.warn(`Failed to remove listener for ${String(event)}`, e);
        stillAttached[event] = fn;
      }
    }

    if (Object.keys(stillAttached).length > 0) {
      this.listeners.set(provider, stillAttached);
    } else {
      this.listeners.delete(provider);
    }
  }

  /** Events still attached to a provider after a failed teardown. */
  attachedEvents(provider: EIP1193Provider): string[] {
    return Object.keys(this.listeners.get(provider) ?? {});
  }

  /**
   * Whether this provider's `request` is already our wrapper.
   *
   * Checks the wrapper's own marker AND that the provider still points at
   * that exact function, so a wallet that replaced `request` after we wrapped
   * it is re-wrapped rather than left uninstrumented.
   */
  isWrapped(
    provider: EIP1193Provider,
    currentRequest: WrappedRequestFunction | undefined
  ): boolean {
    return !!(
      currentRequest &&
      typeof currentRequest === "function" &&
      currentRequest[WRAPPED_REQUEST_SYMBOL] &&
      (provider as WrappedEIP1193Provider)[WRAPPED_REQUEST_REF_SYMBOL] ===
        currentRequest
    );
  }

  // ── per-provider chain knowledge ─────────────────────────────────────────

  chainIdOf(provider: EIP1193Provider): number | undefined {
    return this.chainIds.get(provider);
  }

  /** Advance and return this provider's chain-observation generation. */
  bumpChainGeneration(provider: EIP1193Provider): number {
    const next = (this.chainGenerations.get(provider) ?? 0) + 1;
    this.chainGenerations.set(provider, next);
    return next;
  }

  chainGeneration(provider: EIP1193Provider): number {
    return this.chainGenerations.get(provider) ?? 0;
  }

  /**
   * Record a provider's chain. Fed by `chainChanged` and `connect`, and by
   * the one-off probe at tracking time, never from inside a user request.
   */
  rememberChain(
    provider: EIP1193Provider | undefined,
    chainId: number | undefined
  ): void {
    if (!provider || !chainId) return;
    // Any observation is newer than an `eth_chainId` still in flight for this
    // provider.
    this.bumpChainGeneration(provider);
    this.chainIds.set(provider, chainId);
    this.deps.onChainObserved(provider, chainId);
  }

  /**
   * Resolve the chain an autocaptured request actually ran on.
   *
   * Central chain state is maintained by `chainChanged` from whichever
   * provider is currently active. When a request arrives from a DIFFERENT
   * tracked provider, which happens whenever a visitor has two wallets
   * installed, that cached value describes the wrong wallet, and tagging the
   * event with it silently mis-attributes the chain.
   *
   * Answered entirely from a per-provider snapshot. Deliberately SYNCHRONOUS
   * and never issues an RPC.
   *
   * An earlier version called `eth_chainId` on the signing provider and
   * time-boxed it with `Promise.race`. That is not safe: the race abandons
   * the SDK's promise but cannot cancel the provider's request. On a
   * transport that serialises (WalletConnect's relay socket, the very case
   * this path exists to serve) an abandoned lookup stays at the head of the
   * wallet's queue, and every later RPC the dapp makes queues behind it until
   * reload. Mislabelling a chain is a reporting defect; wedging the user's
   * wallet is not an acceptable way to avoid one.
   *
   * When nothing is known this reports 0 ("unknown") rather than guessing
   * with the active provider's chain, which is known-wrong for another wallet.
   */
  resolveChainId(provider?: EIP1193Provider): number {
    if (provider) {
      const known = this.chainIds.get(provider);
      if (known) return known;
      // Only the active provider's chain is described by central state.
      const activeChain = this.deps.activeChainId();
      if (provider === this.deps.activeProvider() && activeChain) {
        return activeChain;
      }
      // A tracked provider we have never heard a chain from. Deliberately no
      // fall back to central state: it belongs to a different wallet.
      return 0;
    }
    return this.deps.activeChainId() || 0;
  }

  // ── reading accounts off a provider ──────────────────────────────────────

  /**
   * The wallet's first account, or null.
   *
   * Prefers what the SDK already knows, so an EVM context never returns a
   * Solana address and no RPC is issued when the answer is already in hand.
   */
  async addressOf(provider?: EIP1193Provider): Promise<Address | null> {
    const active = this.deps.activeProvider();
    const p = provider || active;

    // The cached wallet describes the ACTIVE provider, so it may only answer
    // for that one. Returning it for any provider reported the active wallet's
    // address under every other wallet's name and rdns, which is exactly what
    // `identify()` does when it scans the providers it has discovered.
    if (!provider || provider === active) {
      const known = this.deps.knownEvmAddress();
      if (known) return known;
    }

    if (!p) {
      logger.info("The provider is not set");
      return null;
    }
    const accounts = await this.accountsOf(p);
    if (accounts && accounts.length > 0) {
      return validateAndChecksumAddress(accounts[0]) || null;
    }
    return null;
  }

  /** Every checksummed account a provider reports, or null. */
  async accountsOf(provider?: EIP1193Provider): Promise<Address[] | null> {
    const p = provider || this.deps.activeProvider();
    try {
      const res: string[] | null | undefined = await p?.request({
        method: "eth_accounts",
      });
      if (!res || res.length === 0) return null;
      return res
        .map((e) => validateAndChecksumAddress(e))
        .filter((e): e is Address => e !== undefined);
    } catch (err) {
      // 4001 is the user declining, which is an answer, not a fault.
      const code = (err as RPCError)?.code;
      if (code !== 4001) {
        logger.error(
          "EvmProviderRegistry::accountsOf: eth_accounts threw an error",
          err
        );
      }
      return null;
    }
  }
}
