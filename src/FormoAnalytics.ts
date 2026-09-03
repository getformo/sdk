import { EIP6963ProviderDetail } from "mipd";
import {
  EVENTS_API_HOST,
  EventType,
  LOCAL_ANONYMOUS_ID_KEY,
  SESSION_USER_ID_KEY,
  SESSION_TRAFFIC_SOURCE_KEY,
  ACTIVE_WALLET_KEY,
  CONSENT_OPT_OUT_KEY,
  TEventType,
} from "./constants";
import { cookie, session, initStorageManager } from "./storage";
import {
  getIdentityCookieDomain,
  getIdentityCookieSecurity,
} from "./storage/cookiePolicy";
import { EventManager, IEventManager } from "./event";
import { clearAnonymousId } from "./event/utils";
import { EventQueue } from "./queue";
import { logger, Logger } from "./logger";
import {
  setConsentFlag,
  getConsentFlag,
  removeConsentFlag,
} from "./consent";
import {
  FormoAnalyticsSession,
  SESSION_WALLET_DETECTED_KEY,
  SESSION_WALLET_IDENTIFIED_KEY,
} from "./session";
import {
  Address,
  ChainID,
  ChainNamespace,
  Config,
  EIP1193Provider,
  IFormoAnalytics,
  IFormoEventContext,
  IFormoEventProperties,
  Options,
  SignatureStatus,
  TransactionStatus,
  WrappedRequestFunction,
} from "./types";
import { validateAddress, validateAndChecksumAddress } from "./utils/address";
import {
  AutocaptureEventType,
  ITrackingPolicy,
  TrackingPolicy,
} from "./tracking/TrackingPolicy";
import { WalletStateStore } from "./wallet/WalletStateStore";
import { EvmProviderRegistry } from "./evm/EvmProviderRegistry";
import {
  detectInjectedProviderInfo,
  isValidProvider,
  readWalletConnectPeer,
} from "./provider";
import { EvmEventTracker } from "./evm/EvmEventTracker";
import { EvmRequestTracker } from "./evm/EvmRequestTracker";
import { parseChainId } from "./utils/chain";
import { WagmiEventHandler } from "./wagmi";
import { isSolanaChainId } from "./solana";
import { SolanaManager } from "./solana/SolanaManager";
// Internal: the Privy identify is reached through identify(user), not exported.
import { identifyPrivyUser } from "./privy/utils";
import type { PrivyUser } from "./privy";


/**
 * Constants for provider switching reasons
 */
export class FormoAnalytics implements IFormoAnalytics {
  // Per-chain namespace state - isolates EVM and Solana connection state
  /** Wallet identity, chain state and the active-wallet cookie. */
  private wallet: WalletStateStore;

  private get _provider(): EIP1193Provider | undefined {
    return this.wallet.provider;
  }

  private set _provider(value: EIP1193Provider | undefined) {
    this.wallet.provider = value;
  }

  private get _evmAddress(): Address | undefined {
    return this.wallet.evmAddress;
  }

  private get _evmChainId(): ChainID | undefined {
    return this.wallet.evmChainId;
  }

  private _announcedConnect = new WeakMap<
    EIP1193Provider,
    { address: string; chainId: number }
  >();

  private session: FormoAnalyticsSession;
  private eventManager: IEventManager;
  /** Which EVM wallets exist, and what is known about each. */
  private evm: EvmProviderRegistry;
  /** Which providers to watch, and what their events mean. */
  private evmEvents: EvmEventTracker;
  /** Autocapture for signatures and transactions. */
  private evmRequests: EvmRequestTracker;
  /** Every "may we track this?" rule. See src/tracking/TrackingPolicy.ts. */
  private trackingPolicy: ITrackingPolicy;
  // Cache for injected provider detection to avoid redundant operations
  // Flag to prevent concurrent processing of accountsChanged events
  // Set to efficiently track seen providers for deduplication and O(1) lookup
  /**
   * Wagmi event handler for tracking wallet events via Wagmi v2
   * Only initialized when options.wagmi is provided
   */
  private wagmiHandler?: WagmiEventHandler;

  /**
   * Solana integration manager for tracking Solana wallet events.
   * Only initialized when options.solana is provided or via formo.solana.
   */
  private solanaManager?: SolanaManager;

  /**
   * Flag indicating if Wagmi mode is enabled
   * When true, EIP-1193 provider wrapping is skipped
   */
  private isWagmiMode: boolean = false;

  /**
   * Flag indicating if EVM provider tracking is disabled.
   * When true, all EIP-1193/EIP-6963 detection and wrapping is skipped.
   */
  private isEvmDisabled: boolean = false;

  /** Instance-level flag so multiple SDK instances don't interfere. */
  private crossSubdomainCookies: boolean;

  /** In-memory URL used to deduplicate SPA pageview events. */
  private _currentUrl: string = "";

  /** Page-hit hooks installed in trackPageHits() so cleanup() can undo them. */
  private _onPopStateListener?: (e: Event) => void;
  private _onLocationChangeListener?: (e: Event) => void;
  private _pageHooksDisposed = false;

  config: Config;
  /**
   * The wallet later events are attributed to, derived from whichever
   * namespace last claimed the slot. Read by the wagmi and Privy
   * integrations; the store is the only writer.
   */
  get currentAddress(): Address | undefined {
    return this.wallet.address;
  }

  get currentChainId(): ChainID | undefined {
    return this.wallet.chainId;
  }

  /**
   * These stay writable.
   *
   * Both were public mutable fields, so a consumer assigning one is using a
   * documented public API. Getter-only replacements would break that
   * silently: TypeScript rejects the assignment, and plain JavaScript throws
   * on an accessor with no setter. The writes forward into the store, which
   * keeps a single owner without turning a refactor into a breaking change.
   */
  set currentAddress(value: Address | undefined) {
    this.wallet.setActiveAddress(value);
  }

  set currentChainId(value: ChainID | undefined) {
    this.wallet.setActiveChainId(value);
  }
  currentUserId?: string = "";


  private constructor(
    public readonly writeKey: string,
    public options: Options = {}
  ) {
    this.config = {
      writeKey,
    };
    this.options = options;

    // Check if Wagmi mode is enabled
    this.isWagmiMode = !!options.wagmi;
    this.isEvmDisabled = options.evm === false;
    this.crossSubdomainCookies = options.crossSubdomainCookies ?? true;
    // Normalize so downstream consumers (EventFactory) read the resolved value.
    options.crossSubdomainCookies = this.crossSubdomainCookies;

    this.session = new FormoAnalyticsSession();
    this.currentUserId =
      (cookie().get(SESSION_USER_ID_KEY) as string) || undefined;

    this.identify = this.identify.bind(this);
    this.connect = this.connect.bind(this);
    this.disconnect = this.disconnect.bind(this);
    this.chain = this.chain.bind(this);
    this.signature = this.signature.bind(this);
    this.transaction = this.transaction.bind(this);
    this.detect = this.detect.bind(this);
    this.track = this.track.bind(this);
    this.registerProvider = this.registerProvider.bind(this);
    this.page = this.page.bind(this);
    this.reset = this.reset.bind(this);
    this.cleanup = this.cleanup.bind(this);
    this.optOutTracking = this.optOutTracking.bind(this);
    this.optInTracking = this.optInTracking.bind(this);
    this.hasOptedOutTracking = this.hasOptedOutTracking.bind(this);
    this.isAutocaptureEnabled = this.isAutocaptureEnabled.bind(this);
    this.syncPrivyActiveChain = this.syncPrivyActiveChain.bind(this);
    this.isTrackingSuppressed = this.isTrackingSuppressed.bind(this);
    this.getTrackedProvidersCount = this.getTrackedProvidersCount.bind(this);
    this.getProviderState = this.getProviderState.bind(this);
    this.syncWalletState = this.syncWalletState.bind(this);

    // Initialize logger with configuration from options
    Logger.init({
      enabled: options.logger?.enabled || false,
      enabledLevels: options.logger?.levels || [],
    });

    this.evm = new EvmProviderRegistry({
      activeProvider: () => this.wallet.provider,
      activeChainId: () => this.wallet.evmChainId,
      knownEvmAddress: () => this.wallet.evmAddress,
      // Whether central state should follow a provider's chain report is the
      // SDK's call, not the registry's: it depends on which namespace is
      // active. Recording it per provider is unconditional; syncing is not.
      onChainObserved: (provider, chainId) => {
        // Guarded on EVM already being active. `set()` makes whichever
        // namespace it touches active, so syncing unconditionally let a
        // background EVM wallet's chain report steal the slot from a live
        // Solana wallet, and every later page or track event was attributed
        // to the wrong wallet entirely.
        if (
          provider === this.wallet.provider &&
          this.wallet.activeNamespace === "evm" &&
          this.wallet.evmChainId !== chainId
        ) {
          this.wallet.set("evm", { chainId });
        }
      },
    });

    this.wallet = new WalletStateStore({
      isPersistedIdentityPurgeRequired: () =>
        this.trackingPolicy.isPersistedIdentityPurgeRequired(),
      isPageExcluded: () => this.trackingPolicy.isPageExcluded(),
      isTrackingSuppressed: () => this.trackingPolicy.isTrackingSuppressed(),
      crossSubdomainCookies: () => this.crossSubdomainCookies,
      providerChainId: (provider) => this.evm.chainIdOf(provider),
      // A provider that stops being active has, from this SDK's point of
      // view, ended its connection, so the connect it reported must stop
      // counting. Otherwise toggling between two installed wallets silently
      // loses every connect after the first.
      onProviderDisplaced: (previous) =>
        this.evmEvents.forgetAnnouncedConnect(previous),
    });

    this.evmRequests = new EvmRequestTracker(this.wallet, this.evm, {
      isAutocaptureEnabled: (t) => this.isAutocaptureEnabled(t),
      signature: (params, properties) => this.signature(params, properties),
      transaction: (params, properties) => this.transaction(params, properties),
      // Hybrid capture: in wagmi mode the wrapper skips a request that a
      // PENDING wagmi mutation already covers - the mutation handler
      // captures it with ABI enrichment - and captures everything else
      // (imperative viem calls that create no mutation).
      shouldSkipRequestCapture: (method, params) =>
        this.wagmiHandler?.hasMatchingPendingMutation(method, params) ?? false,
    });

    this.evmEvents = new EvmEventTracker(this.wallet, this.evm, {
      isAutocaptureEnabled: (t) => this.isAutocaptureEnabled(t),
      isTrackingSuppressed: () => this.isTrackingSuppressed(),
      willTrackEvent: (chainId) => this.willTrackEvent(chainId),
      isWagmiMode: () => this.isWagmiMode,
      connect: (params, properties) => this.connect(params, properties),
      disconnect: (params) => this.disconnect(params),
      chain: (params, properties) => this.chain(params, properties),
      detect: (params) => this.detect(params),
      registerRequestListeners: (provider) =>
        this.evmRequests.registerRequestListeners(provider),
    });

    this.trackingPolicy = new TrackingPolicy({
      // All three read lazily. `options` is public and mutable, and the
      // central chain moves as wallets connect and switch, so the policy
      // must see both at decision time rather than at construction.
      options: () => this.options,
      hasOptedOut: () => this.hasOptedOutTracking(),
      currentChainId: () => this.currentChainId,
    });

    this.eventManager = new EventManager(
      new EventQueue(this.config.writeKey, {
        apiHost: options.apiHost || EVENTS_API_HOST,
        flushAt: options.flushAt,
        retryCount: options.retryCount,
        maxQueueSize: options.maxQueueSize,
        flushInterval: options.flushInterval,
        errorHandler: options.errorHandler,
        // Hard consent gate at the queue boundary: nothing buffered is
        // ever sent once the user has opted out, even via a timer or
        // pagehide flush scheduled before opt-out.
        canSend: () => !this.hasOptedOutTracking(),
      }),
      options
    );

    // Check consent status on initialization
    if (this.hasOptedOutTracking()) {
      logger.info("User has previously opted out of tracking");
    }

    // Initialize EVM provider tracking (unless explicitly disabled)
    if (this.isEvmDisabled) {
      logger.info("FormoAnalytics: EVM provider tracking disabled");
    } else if (this.isWagmiMode && options.wagmi) {
      logger.info("FormoAnalytics: Initializing in Wagmi mode");
      this.wagmiHandler = new WagmiEventHandler(
        this,
        options.wagmi.config,
        options.wagmi.queryClient
      );
    } else {
      // Handle initial provider (injected) as fallback; listeners for EIP-6963 are added later
      let provider: EIP1193Provider | undefined = undefined;
      const optProvider = options.provider as EIP1193Provider | undefined;
      if (optProvider) {
        provider = optProvider;
      } else if (typeof window !== "undefined" && window.ethereum) {
        provider = window.ethereum;
      }

      if (provider) {
        this.evmEvents.trackEIP1193Provider(provider);
      }
    }

    // Initialize Solana manager if Solana options are provided
    if (options.solana) {
      this.solanaManager = new SolanaManager(this, options.solana);
    }

    this._currentUrl = window.location.href;

    // Seed currentAddress/currentChainId from the persisted snapshot before
    // the first page hit queues so reload-time track()/page() carry the
    // wallet even before wagmi/EIP-1193 reconnection completes.
    this.wallet.load();

    this.trackPageHit();
    this.trackPageHits();
  }

  static async init(
    writeKey: string,
    options?: Options
  ): Promise<FormoAnalytics> {
    initStorageManager(writeKey);
    const analytics = new FormoAnalytics(writeKey, options);

    // Skip provider detection in Wagmi mode or when EVM is disabled
    if (analytics.isEvmDisabled) {
      logger.info("FormoAnalytics: Skipping provider detection (EVM disabled)");
    } else if (!analytics.isWagmiMode) {
      // Auto-detect wallet provider
      const discovered = await analytics.evmEvents.getProviders();
      await analytics.evmEvents.detectWallets(discovered);
      analytics.evmEvents.trackProviders(discovered);
    } else {
      // Wagmi owns connect / transaction capture, so discovered providers
      // are not wrapped. Discovery still runs for the `detect` event: which
      // wallets are installed must read the same in every integration mode.
      // Skipping it here silently zeroed detect for every wagmi customer.
      // Best-effort: detect must never stop wagmi capture from coming up.
      try {
        const discovered = await analytics.evmEvents.getProviders();
        await analytics.evmEvents.detectWallets(discovered);
      } catch (error) {
        logger.warn("FormoAnalytics: Provider discovery failed", error);
      }
    }

    return analytics;
  }

  /*
    Public SDK functions
  */

  /**
   * Emits a page visit event with the current URL information, fire on page change.
   * @param {string} category - The category of the page
   * @param {string} name - The name of the page
   * @param {Record<string, any>} properties - Additional properties to include
   * @param {Record<string, any>} context - Additional context to include
   * @param {(...args: unknown[]) => void} callback - Optional callback function
   * @returns {Promise<void>}
   */
  public async page(
    category?: string,
    name?: string,
    properties?: IFormoEventProperties,
    context?: IFormoEventContext,
    callback?: (...args: unknown[]) => void
  ): Promise<void> {
    await this.trackPageHit(category, name, properties, context, callback);
  }

  /**
   * Reset the current user session: forget the user id, the active wallet
   * and the per-session identity flags. The anonymous id is kept; it is the
   * browser id, not the user id. Use `optOutTracking()` to clear it too.
   * @returns {void}
   */
  public reset(): void {
    this.currentUserId = undefined;

    // Clear in-memory wallet identity too. Without this, a logout/reset
    // (also triggered by optOutTracking) still leaks the previous wallet
    // address on subsequent track()/page() events for the rest of the
    // page lifetime, because they fall back to currentAddress. Keep the
    // EVM provider reference so tracking can resume on the next connect.
    this.wallet.reset();

    // The anonymous id stays. It identifies the browser, not the user, and
    // it is the Visitors denominator and the anon-to-wallet stitch key.
    // Apps call reset() on every wallet switch (often as an effect cleanup
    // right before the next identify()); dropping the id there turned one
    // visitor into one per switch. Only optOutTracking() clears it.
    cookie().remove(SESSION_USER_ID_KEY);
    cookie().remove(SESSION_WALLET_DETECTED_KEY);
    cookie().remove(SESSION_WALLET_IDENTIFIED_KEY);
    cookie().remove(ACTIVE_WALLET_KEY);

    // Stored traffic-source attribution (referrer/UTM) is tracking data;
    // clear it too so reset()/optOutTracking() don't leave it to be
    // re-attached to the next session's events.
    session().remove(SESSION_TRAFFIC_SOURCE_KEY);
  }

  /**
   * Clean up resources and event listeners
   * Call this when destroying the analytics instance
   * @returns {void}
   */
  /** Set by cleanup(); a torn-down instance refuses new registrations. */
  private isCleanedUp = false;

  public cleanup(): void {
    this.isCleanedUp = true;
    logger.debug("FormoAnalytics: Cleaning up resources");

    // Close the queue, don't just empty it. clear() only drops what is
    // buffered at this instant; asynchronous work already in flight (event
    // creation is async on every emit path) would still enqueue afterwards,
    // and an empty queue flushes immediately. close() is terminal, so a
    // continuation that outlives this instance cannot send with its stale
    // options. See issue #339.
    this.eventManager.close();

    // Stop any receipt or batch-status polling: a torn-down instance must
    // not keep asking a wallet about transactions nobody is listening for.
    this.evmRequests.cleanup();
    // Stop reacting to wallet announcements: a disposed instance must not
    // wrap new providers or emit detect events.
    this.evmEvents.cleanup();

    // Clean up Wagmi handler if present
    if (this.wagmiHandler) {
      this.wagmiHandler.cleanup();
      this.wagmiHandler = undefined;
    }

    // Clean up Solana manager if present
    if (this.solanaManager) {
      this.solanaManager.cleanup();
      this.solanaManager = undefined;
    }

    // Clean up EIP-1193 providers if not in Wagmi mode
    if (!this.isWagmiMode) {
      for (const provider of this.evm.trackedProviders()) {
        this.evmEvents.untrackProvider(provider);
      }
    }

    // Tear down page-hit hooks: remove window listeners and silence the
    // history.pushState/replaceState wrappers so an orphaned instance (e.g.
    // from a re-mount in React Strict Mode / HMR) stops emitting page events
    // with stale state.
    this._pageHooksDisposed = true;
    if (typeof window !== "undefined") {
      if (this._onPopStateListener) {
        window.removeEventListener("popstate", this._onPopStateListener);
        this._onPopStateListener = undefined;
      }
      if (this._onLocationChangeListener) {
        window.removeEventListener("locationchange", this._onLocationChangeListener);
        this._onLocationChangeListener = undefined;
      }
    }

    logger.debug("FormoAnalytics: Cleanup complete");
  }

  /**
   * Emits a connect wallet event.
   * @param {ChainID} params.chainId
   * @param {Address} params.address
   * @param {IFormoEventProperties} properties
   * @param {IFormoEventContext} context
   * @param {(...args: unknown[]) => void} callback
   * @returns {Promise<void>}
   */
  async connect(
    {
      chainId,
      address,
    }: {
      chainId: ChainID;
      address: Address;
    },
    properties?: IFormoEventProperties,
    context?: IFormoEventContext,
    callback?: (...args: unknown[]) => void
  ): Promise<void> {
    if (chainId === null || chainId === undefined) {
      logger.warn("Connect: Chain ID cannot be null or undefined");
      return;
    }
    if (!address) {
      logger.warn("Connect: Address cannot be empty");
      return;
    }

    const validAddress = validateAddress(address, chainId);
    if (!validAddress) {
      logger.warn(
        `Connect: Invalid address provided ("${address}"). Please provide a valid EVM or Solana address.`
      );
      return;
    }

    // connect() persists wallet/chain state (active-wallet cookie,
    // currentAddress/currentChainId) before trackEvent's consent check -
    // gate the whole method so a suppressed visitor or excluded environment
    // (opt-out / timezone / host / path) leaves no session state.
    if (this.isTrackingSuppressed()) {
      logger.info("connect() skipped: tracking is suppressed for this visitor or environment");
      return;
    }

    // A new wallet now owns this namespace. Anything already tearing down
    // the previous session must not undo this. An emitted connect always
    // counts, even when the address is the one already there: a wallet that
    // disconnects and reconnects leaves identical state.
    this.wallet.observe(this.wallet.namespaceOf(chainId));

    this.setChainState(chainId, { address: validAddress });

    await this.trackEvent(
      EventType.CONNECT,
      {
        chainId,
        address: validAddress,
      },
      properties,
      context,
      callback
    );
  }

  /**
   * Emits a disconnect wallet event.
   * @param {ChainID} [params.chainId]
   * @param {Address} [params.address]
   * @param {IFormoEventProperties} properties
   * @param {IFormoEventContext} context
   * @param {(...args: unknown[]) => void} callback
   * @returns {Promise<void>}
   */
  async disconnect(
    params?: {
      chainId?: ChainID;
      address?: Address;
    },
    properties?: IFormoEventProperties,
    context?: IFormoEventContext,
    callback?: (...args: unknown[]) => void
  ): Promise<void> {
    const chainId = params?.chainId || this.currentChainId;
    const address = params?.address || this.currentAddress;
    const isSolana = isSolanaChainId(chainId);

    // Only include EVM provider info for non-Solana disconnects
    const providerInfo =
      !isSolana && this._provider
        ? this.getProviderInfo(this._provider)
        : null;

    logger.info("Disconnect: Emitting disconnect event with:", {
      chainId,
      address,
      providerName: providerInfo?.name,
      rdns: providerInfo?.rdns,
    });

    // Always emit disconnect event, even if chainId or address are missing
    // This ensures we track all disconnection attempts for analytics completeness
    const disconnectProperties = {
      ...(providerInfo && {
        providerName: providerInfo.name,
        rdns: providerInfo.rdns,
      }),
      ...properties,
    };

    // Snapshot the session being torn down. Emitting is asynchronous, so a
    // reconnect can land while the disconnect event is still being built.
    const namespace = this.wallet.namespaceOf(chainId);
    // Every teardown announces itself here, before anything is awaited,
    // whichever path reached it - a provider event or a direct call from the
    // host app. A connect observation that began earlier is invalidated; one
    // that begins after this point is a genuine reconnect and still reports.
    this.wallet.beginDisconnect(namespace);
    const before = this.wallet.snapshot(namespace);

    await this.trackEvent(
      EventType.DISCONNECT,
      {
        ...(chainId && { chainId }),
        ...(address && { address }),
      },
      disconnectProperties,
      context,
      callback
    );

    // If a wallet claimed this namespace while the event was being built, a
    // new session owns it and this cleanup is stale. Running it anyway would
    // wipe that session's state AND its reported-connect record, so a later
    // wallet signal would emit a second connect for a connection that is
    // already reported. See issue #344.
    if (!this.wallet.isUnchangedSince(namespace, before)) {
      logger.info(
        "Disconnect: A new session claimed this namespace while the event was in flight; leaving its state intact"
      );
      return;
    }

    // Clear the disconnecting chain's namespace state.
    // Per-chain isolation ensures a Solana disconnect never wipes EVM state (and vice versa).
    this.clearChainState(chainId);
    logger.info(
      "Wallet disconnected: Cleared currentAddress, currentChainId, and provider"
    );
  }


  /** @see WalletStateStore.set */
  private setChainState(
    namespaceOrChainId: ChainNamespace | ChainID | undefined,
    update: { address?: Address; chainId?: ChainID; provider?: EIP1193Provider }
  ): void {
    this.wallet.set(namespaceOrChainId, update);
  }

  /** @see WalletStateStore.clear */
  private clearChainState(
    namespaceOrChainId: ChainNamespace | ChainID | undefined
  ): void {
    this.wallet.clear(namespaceOrChainId);
  }

  /**
   * Record validated wallet/chain state WITHOUT emitting an event.
   *
   * Integrations must call this on every connect / chain change / disconnect,
   * even when the matching autocapture event is disabled, or the exclusion
   * gate (which keys off the central chain, not the event payload) can be
   * bypassed. Stays on the class because integrations bind to it.
   * @see WalletStateStore.syncWalletState
   */
  public syncWalletState(params: {
    chainId?: ChainID;
    address?: Address;
  }): void {
    this.wallet.syncWalletState(params);
  }


  /** @see WalletStateStore.clearProvider */
  private clearActiveProvider(): void {
    this.wallet.clearProvider();
  }

  /** @see WalletStateStore.backfill */
  private backfillActiveWallet(
    address: Address,
    chainId?: ChainID,
    provider?: EIP1193Provider
  ): void {
    this.wallet.backfill(address, chainId, provider);
  }

  /** @see WalletStateStore.clearStaleEvmWalletOnSwitchWhileSuppressed */
  private clearStaleEvmWalletOnSwitchWhileSuppressed(address: string): void {
    this.wallet.clearStaleEvmWalletOnSwitchWhileSuppressed(address);
  }

  /** @see EvmProviderRegistry.addListener */
  private addProviderListener(
    provider: EIP1193Provider,
    event: string,
    listener: (...args: unknown[]) => void
  ): void {
    this.evm.addListener(provider, event, listener);
  }

  /** @see EvmProviderRegistry.removeListeners */
  private removeProviderListeners(provider: EIP1193Provider): void {
    this.evm.removeListeners(provider);
  }

  /** @see EvmProviderRegistry.infoFor */
  private getProviderInfo(provider: EIP1193Provider): {
    name: string;
    rdns: string;
  } {
    return this.evm.infoFor(provider);
  }

  /** @see EvmProviderRegistry.isWrapped */
  private isProviderAlreadyWrapped(
    provider: EIP1193Provider,
    currentRequest: WrappedRequestFunction | undefined
  ): boolean {
    return this.evm.isWrapped(provider, currentRequest);
  }

  /** @see EvmProviderRegistry.resolveChainId */
  private resolveChainIdForProvider(provider?: EIP1193Provider): number {
    return this.evm.resolveChainId(provider);
  }

  /** @see EvmProviderRegistry.rememberChain */
  private rememberProviderChain(
    provider: EIP1193Provider | undefined,
    chainId: number | undefined
  ): void {
    this.evm.rememberChain(provider, chainId);
  }

  /** @see EvmProviderRegistry.addressOf */
  private async getAddress(
    provider?: EIP1193Provider
  ): Promise<Address | null> {
    return this.evm.addressOf(provider);
  }

  /** @see EvmProviderRegistry.accountsOf */
  private async getAccounts(
    provider?: EIP1193Provider
  ): Promise<Address[] | null> {
    return this.evm.accountsOf(provider);
  }

  /**
   * Emits a chain network change event.
   * @param {ChainID} params.chainId
   * @param {Address} params.address
   * @param {IFormoEventProperties} properties
   * @param {IFormoEventContext} context
   * @param {(...args: unknown[]) => void} callback
   * @returns {Promise<void>}
   */
  async chain(
    {
      chainId,
      address,
    }: {
      chainId: ChainID;
      address?: Address;
    },
    properties?: IFormoEventProperties,
    context?: IFormoEventContext,
    callback?: (...args: unknown[]) => void
  ): Promise<void> {
    if (!chainId || Number(chainId) === 0) {
      logger.warn("FormoAnalytics::chain: chainId cannot be empty or 0");
      return;
    }
    if (isNaN(Number(chainId))) {
      logger.warn(
        "FormoAnalytics::chain: chainId must be a valid decimal number"
      );
      return;
    }
    if (!address && !this.currentAddress) {
      logger.warn(
        "FormoAnalytics::chain: address was empty and no previous address has been recorded"
      );
      return;
    }

    this.setChainState(chainId, {});

    await this.trackEvent(
      EventType.CHAIN,
      {
        chainId,
        address: address || this.currentAddress,
      },
      properties,
      context,
      callback
    );
  }

  /**
   * Emits a signature event.
   * @param {SignatureStatus} params.status - requested, confirmed, rejected
   * @param {ChainID} params.chainId
   * @param {Address} params.address
   * @param {string} params.message
   * @param {IFormoEventProperties} properties
   * @param {IFormoEventContext} context
   * @param {(...args: unknown[]) => void} callback
   * @returns {Promise<void>}
   */
  async signature(
    {
      status,
      chainId,
      address,
      message,
    }: {
      status: SignatureStatus;
      chainId?: ChainID;
      address: Address;
      message: string;
    },
    properties?: IFormoEventProperties,
    context?: IFormoEventContext,
    callback?: (...args: unknown[]) => void
  ): Promise<void> {
    await this.trackEvent(
      EventType.SIGNATURE,
      {
        status,
        chainId,
        address,
        message,
      },
      properties,
      context,
      callback
    );
  }

  /**
   * Emits a transaction event.
   * @param {TransactionStatus} params.status - started, broadcasted, rejected
   * @param {ChainID} params.chainId
   * @param {Address} params.address
   * @param {string} params.data
   * @param {string} params.to
   * @param {string} params.value
   * @param {string} params.transactionHash - only provided if status is broadcasted
   * @param {IFormoEventProperties} properties
   * @param {IFormoEventContext} context
   * @param {(...args: unknown[]) => void} callback
   * @returns {Promise<void>}
   */
  async transaction(
    {
      status,
      chainId,
      address,
      data,
      to,
      value,
      transactionHash,
      function_name,
      function_args,
    }: {
      status: TransactionStatus;
      chainId: ChainID;
      address: Address;
      data?: string;
      to?: string;
      value?: string;
      transactionHash?: string;
      function_name?: string;
      function_args?: Record<string, unknown>;
    },
    properties?: IFormoEventProperties,
    context?: IFormoEventContext,
    callback?: (...args: unknown[]) => void
  ): Promise<void> {
    await this.trackEvent(
      EventType.TRANSACTION,
      {
        status,
        chainId,
        address,
        data,
        to,
        value,
        ...(transactionHash && { transactionHash }),
        ...(function_name && { function_name }),
        ...(function_args && { function_args }),
      },
      properties,
      context,
      callback
    );
  }

  /**
   * Emits an identify event with current wallet address and provider info.
   *
   * @param {string} params.address - Wallet address
   * @param {string} params.userId - External user ID
   * @param {string} params.rdns - Provider reverse domain name
   * @param {string} params.providerName - Provider display name
   * @param {IFormoEventProperties} properties - Additional properties to include with the identify event
   * @param {IFormoEventContext} context
   * @param {(...args: unknown[]) => void} callback
   * @returns {Promise<void>}
   *
   * @example
   * ```ts
   * // Basic identify
   * formo.identify({ address: '0x...', userId: 'user123' });
   *
   * // Privy: pass the usePrivy() user to identify every linked wallet under
   * // the user's DID in one call. Attribution stays on the already-connected
   * // wallet when there is one, else Privy's primary (user.wallet); pass
   * // `activeAddress` to pin a specific wallet.
   * const { user } = usePrivy();
   * if (user) formo.identify(user);
   * ```
   */
  async identify(
    user: PrivyUser,
    options?: {
      activeAddress?: string;
      properties?: IFormoEventProperties;
    }
  ): Promise<void>;
  async identify(
    params?: {
      address: Address;
      providerName?: string;
      userId?: string;
      rdns?: string;
    },
    properties?: IFormoEventProperties,
    context?: IFormoEventContext,
    callback?: (...args: unknown[]) => void
  ): Promise<void>;
  async identify(
    paramsOrUser?:
      | {
          address: Address;
          providerName?: string;
          userId?: string;
          rdns?: string;
        }
      | PrivyUser,
    propertiesOrOptions?:
      | IFormoEventProperties
      | { activeAddress?: string; properties?: IFormoEventProperties },
    context?: IFormoEventContext,
    callback?: (...args: unknown[]) => void
  ): Promise<void> {
    try {
      // Privy form: identify(user) / identify(user, { activeAddress? }).
      // Delegate to the Privy adapter, which expands the user's linked wallets
      // into one identify per wallet under the shared DID. Kept as a thin
      // dispatch so the Privy-specific logic stays in the privy module.
      //
      // Recognized purely by shape, so no flag is needed at the call site. The
      // two forms are mutually exclusive: an address-keyed identify always
      // carries an `address` (it is the required field and the thing the event
      // is keyed on), while a Privy user carries a string `id` and never a
      // top-level `address`. Requiring the absence of `address` is what keeps a
      // normal identify from ever being mistaken for a Privy user.
      const maybeUser = paramsOrUser as
        | (Partial<PrivyUser> & { address?: unknown })
        | undefined;
      if (
        maybeUser &&
        typeof maybeUser.id === "string" &&
        maybeUser.address === undefined
      ) {
        // Options are optional: `identify(user)` is the common call.
        const opts = (propertiesOrOptions ?? {}) as {
          activeAddress?: string;
          properties?: IFormoEventProperties;
        };
        // identifyPrivyUser records every linked wallet for clustering WITHOUT
        // touching active state (internal setActive:false), promotes only the
        // resolved active wallet, and reconciles the chain id with that wallet's
        // namespace before emitting. It reads this.currentAddress itself to
        // preserve an already-connected wallet, so this dispatch is a thin
        // pass-through and both entry points behave identically.
        await identifyPrivyUser(this, maybeUser as PrivyUser, {
          activeAddress: opts.activeAddress,
          properties: opts.properties,
        });
        return;
      }

      const params = paramsOrUser as
        | {
            address: Address;
            providerName?: string;
            userId?: string;
            rdns?: string;
            // Internal only (not on the public IFormoAnalytics.identify overloads):
            // when false, record the wallet↔user link for clustering/dedup but do
            // NOT change the SDK's active identity. Used by identifyPrivyUser so
            // clustering identifies for non-active wallets don't hijack attribution.
            setActive?: boolean;
          }
        | undefined;
      const properties = propertiesOrOptions as IFormoEventProperties | undefined;

      // identify() writes the user-id cookie and marks wallet
      // identification before trackEvent's consent check - gate the whole
      // method so a suppressed visitor or excluded environment (opt-out /
      // timezone / host / path) gets no identity persistence.
      //
      // The chain check belongs here and NOT in isTrackingSuppressed(), which
      // identifyPrivyUser calls before it reconciles the chain. Folding it in
      // there would block a Privy sync that reconciliation was about to make
      // valid (activating a Solana wallet while an excluded EVM chain id is
      // still current). By the time the Privy path reaches this guard it has
      // already reconciled, so each inner identify is judged on the right chain.
      if (this.isTrackingSuppressed() || this.trackingPolicy.isChainExcluded()) {
        logger.info(
          "identify() skipped: tracking is suppressed for this visitor, environment, or chain"
        );
        return;
      }
      if (!params) {
        // Discovery runs in wagmi mode for detect only, so the registry
        // holds wallets wagmi never connected. Identifying those from
        // eth_accounts would attribute a wallet the user never chose. Before
        // discovery ran here the registry was empty, so this is a no-op as
        // before.
        if (this.isWagmiMode) {
          logger.info("identify() without params is a no-op in Wagmi mode");
          return;
        }
        // If no params provided, auto-identify
        logger.info(
          "Auto-identifying with providers:",
          this.evm.all.map((p) => p.info.name)
        );
        for (const providerDetail of this.evm.all) {
          const provider = providerDetail.provider as EIP1193Provider;
          if (!provider) continue;

          try {
            const address = await this.getAddress(provider);
            if (address) {
              const validAddress = validateAndChecksumAddress(address);
              logger.info("Auto-identify: Checking deduplication", {
                validAddress,
                rdns: providerDetail.info.rdns,
                providerName: providerDetail.info.name,
                isAlreadyIdentified: validAddress
                  ? this.session.isWalletIdentified(
                      validAddress,
                      providerDetail.info.rdns,
                      undefined,
                      properties
                    )
                  : false,
              });

              // Pass `properties` so this pre-check uses the same dedup key as
              // the inner identify() below. Omitting them would let a stored
              // no-properties key short-circuit here and silently skip an
              // identify whose properties have changed.
              if (
                validAddress &&
                !this.session.isWalletIdentified(
                  validAddress,
                  providerDetail.info.rdns,
                  undefined,
                  properties
                )
              ) {
                logger.info(
                  "Auto-identifying",
                  validAddress,
                  providerDetail.info.name,
                  providerDetail.info.rdns
                );
                // NOTE: do not set this.currentAddress without explicit connect or identify
                await this.identify(
                  {
                    address: validAddress,
                    providerName: providerDetail.info.name,
                    rdns: providerDetail.info.rdns,
                  },
                  properties,
                  context,
                  callback
                );
              } else if (validAddress) {
                logger.info(
                  "Auto-identify: Skipping already identified wallet",
                  validAddress,
                  providerDetail.info.name,
                  providerDetail.info.rdns
                );
              }
            }
          } catch (err) {
            logger.error(
              `Failed to identify provider ${providerDetail.info.name}:`,
              err
            );
          }
        }
        return;
      }

      const { address, providerName, userId, rdns, setActive } = params;

      // Runtime validation: address is required
      if (!address) {
        logger.warn?.("identify() called without address - address is required");
        return;
      }

      // Explicit identify
      logger.info("Identify", address, userId, providerName, rdns);
      const validAddress = validateAddress(address);
      if (!validAddress) {
        logger.warn?.("Invalid address provided to identify:", address);
        return;
      }
      // Promote this wallet to the SDK's active identity - the (currentAddress,
      // currentUserId) pair later events are attributed to - unless the caller
      // opts out with setActive:false. A non-active identify still emits its
      // event and marks dedup below (for clustering), it just doesn't repoint
      // attribution. Gating address and userId together prevents leaving the
      // active address paired with a different wallet's user id.
      if (setActive !== false) {
        this.wallet.setActiveAddress(validAddress);
        if (userId) {
          this.currentUserId = userId;
          const domain = getIdentityCookieDomain(this.crossSubdomainCookies);
          cookie().set(SESSION_USER_ID_KEY, userId, {
            path: "/",
            ...getIdentityCookieSecurity(),
            ...(domain ? { domain } : {}),
          });
        }
      }

      // Check for duplicate identify events in this session. The userId and a
      // fingerprint of the properties are folded into the dedup key, so
      // re-identifying an already-seen wallet still emits when the identity
      // changed - a newly-attached userId (a Privy DID after login) or changed
      // properties (a Privy user linking a social account, which leaves the
      // wallets and DID untouched). An identical repeat still dedupes.
      const isAlreadyIdentified = this.session.isWalletIdentified(
        validAddress,
        rdns || "",
        userId,
        properties
      );

      logger.debug("Identify: Checking deduplication", {
        validAddress,
        rdns,
        providerName,
        userId,
        isAlreadyIdentified,
      });

      if (isAlreadyIdentified) {
        logger.info(
          `Identify: Wallet ${
            providerName || "Unknown"
          } with address ${validAddress} already identified in this session (rdns: ${
            rdns || "empty"
          })`
        );
        return;
      }

      // Mark as identified before emitting the event
      this.session.markWalletIdentified(
        validAddress,
        rdns || "",
        userId,
        properties
      );

      await this.trackEvent(
        EventType.IDENTIFY,
        {
          address: validAddress,
          providerName,
          userId,
          rdns,
        },
        properties,
        context,
        callback
      );
    } catch (e) {
      logger.log("identify error", e);
    }
  }

  /**
   * Reconcile currentChainId with a newly-activated Privy wallet's chain
   * namespace. identify() sets currentAddress but never touches the chain id
   * (that comes from connect()/chain()/wagmi), so activating e.g. a Solana
   * wallet while an EVM chain id is current would leave the address paired with
   * a mismatched chain in events, excludeChains, and the active-wallet cookie.
   *
   * We can't infer the wallet's specific chain id from Privy's chainType, so on
   * a namespace mismatch we clear the chain id rather than assert a wrong one; a
   * real wallet connect will set the correct chain. Same-namespace activations
   * (and wallets whose namespace can't be determined) leave the chain id alone.
   *
   * Privy doesn't always supply `chainType`: a `smart_wallet` entry is
   * `{ type, address, smartWalletType }`, and `cross_app` wallets are bare
   * `{ address }`. A `0x`-prefixed 20-byte address is unambiguously EVM though,
   * so fall back to the address shape - otherwise activating an EVM smart
   * wallet while a Solana chain id is current would leave the address paired
   * with the wrong chain, and an `excludeChains` gate could drop the identify
   * after it was already dedup-marked.
   *
   * @internal Not part of the public IFormoAnalytics contract - invoked by
   * `identifyPrivyUser` (via a structural cast) before it emits, so both the
   * `identify(user,{privy:true})` and direct `identifyPrivyUser()` paths
   * reconcile the chain.
   */
  syncPrivyActiveChain(chainType?: string, address?: string): void {
    if (this.currentChainId === undefined || this.currentChainId === null) return;

    let walletIsSolana: boolean | undefined;
    const namespace = chainType?.toLowerCase();
    // Only recognized namespaces decide. An unknown or future chainType
    // ("bitcoin", "cosmos", …) must stay undecided rather than defaulting to
    // EVM, which would wrongly clear a valid Solana chain id.
    if (namespace === "solana") {
      walletIsSolana = true;
    } else if (namespace === "ethereum") {
      walletIsSolana = false;
    } else if (!namespace && address && /^0x[0-9a-f]{40}$/i.test(address)) {
      // Only the EVM shape is inferable: a non-0x address could be Solana,
      // Bitcoin, Cosmos, … so absence of 0x proves nothing.
      walletIsSolana = false;
    }
    if (walletIsSolana === undefined) return;

    const currentIsSolana = isSolanaChainId(this.currentChainId);
    if (walletIsSolana !== currentIsSolana) {
      this.wallet.setActiveChainId(undefined);
    }
  }

  /**
   * Emits a detect wallet event with current wallet provider info.
   * @param {string} params.providerName
   * @param {string} params.rdns
   * @param {IFormoEventProperties} properties
   * @param {IFormoEventContext} context
   * @param {(...args: unknown[]) => void} callback
   * @returns {Promise<void>}
   */
  async detect(
    {
      providerName,
      rdns,
    }: {
      providerName: string;
      rdns: string;
    },
    properties?: IFormoEventProperties,
    context?: IFormoEventContext,
    callback?: (...args: unknown[]) => void
  ): Promise<void> {
    // detect() marks wallet detection (a cookie write) before
    // trackEvent's consent check - gate it for a suppressed visitor or
    // excluded environment (opt-out / timezone / host / path).
    if (this.isTrackingSuppressed()) {
      logger.info("detect() skipped: tracking is suppressed for this visitor or environment");
      return;
    }
    if (this.session.isWalletDetected(rdns))
      return logger.warn(
        `Detect: Wallet ${providerName} already detected in this session`
      );

    this.session.markWalletDetected(rdns);
    await this.trackEvent(
      EventType.DETECT,
      {
        providerName,
        rdns,
      },
      properties,
      context,
      callback
    );
  }

  /**
   * Emits a custom user event with custom properties.
   * @param {string} event The name of the tracked event
   * @param {IFormoEventProperties} properties
   * @param {IFormoEventContext} context
   * @param {(...args: unknown[]) => void} callback
   * @returns {Promise<void>}
   */
  async track(
    event: string,
    properties?: IFormoEventProperties,
    context?: IFormoEventContext,
    callback?: (...args: unknown[]) => void
  ): Promise<void> {
    await this.trackEvent(
      EventType.TRACK,
      { event },
      properties,
      context,
      callback
    );
  }

  /*
    Consent management functions
  */

  /**
   * Opt out of tracking.
   * @returns {void}
   */
  /**
   * Whether an event carrying this chain would currently be sent.
   *
   * Exposed for integrations that keep their own "already reported" state.
   * `syncWalletState()` can accept a wallet that `trackEvent()` then drops -
   * `tracking: false`, or a chain in `excludeChains` - and an integration that
   * marked it as reported would stay silent about that wallet even after the
   * configuration changed to allow it.
   */
  public willTrackEvent(chainId?: ChainID): boolean {
    return this.shouldTrack(chainId);
  }

  public optOutTracking(): void {
    logger.info("Opting out of tracking");

    // Set opt-out flag in persistent storage using direct cookie access
    // This must be done before switching storage to ensure persistence
    setConsentFlag(this.writeKey, CONSENT_OPT_OUT_KEY, "true");
    // Drop anything already buffered so a pending timer/pagehide flush
    // cannot ship events after consent withdrawal.
    this.eventManager.clear();
    // Identity is purged below; registered sessions must be re-learned
    // on opt-in, and nothing else would retry an already-adopted one.
    this.evmEvents.markRegisteredAdoptionsPending();
    this.reset();
    // Consent withdrawal is the one case where the browser id must go too.
    clearAnonymousId(LOCAL_ANONYMOUS_ID_KEY);

    logger.info("Successfully opted out of tracking");
  }

  /**
   * Opt back into tracking after previously opting out. This will re-enable analytics tracking
   * and switch back to persistent storage.
   * @returns {void}
   */
  public optInTracking(): void {
    // A provider registered while the visitor was opted out had its
    // session adoption refused; nothing else retries it. Guarded: a
    // cleanup() racing this timer must not drive the torn-down tracker.
    setTimeout(() => {
      if (this.isCleanedUp) return;
      try {
        this.evmEvents.retryExternalAdoptions();
      } catch {
        /* adoption retry must never break opt-in */
      }
    }, 0);
    logger.info("Opting back into tracking");

    // Remove opt-out flag
    removeConsentFlag(this.writeKey, CONSENT_OPT_OUT_KEY);

    // A wallet connected while opted out was declined by syncWalletState, and
    // an unchanged wagmi connection produces no status or chain update to
    // retry on. Without this, opting back in leaves that wallet invisible for
    // the rest of the page load.
    this.wagmiHandler?.retryAdoption();

    logger.info("Successfully opted back into tracking");
  }

  /**
   * Check if the user has opted out of tracking.
   * @returns {boolean} True if the user has opted out
   */
  public hasOptedOutTracking(): boolean {
    return getConsentFlag(this.writeKey, CONSENT_OPT_OUT_KEY) === "true";
  }

  /*
    SDK tracking and event listener functions
  */
















  private async onLocationChange(): Promise<void> {
    if (this._currentUrl !== window.location.href) {
      this._currentUrl = window.location.href;
      // Host/path exclusions are evaluated per navigation, so a SPA can leave
      // an excluded route and become trackable without any wallet event
      // firing. The wagmi handler only observes *changes*, so an unchanged
      // connection it was forced to decline earlier would stay invisible for
      // the rest of the page load. Give it a chance to adopt it now.
      this.wagmiHandler?.retryAdoption();
      this.trackPageHit();
    }
  }

  private trackPageHits(): void {
    // Install a single, instance-agnostic wrapper around history.pushState /
    // replaceState so concurrent SDK instances (React Strict Mode, HMR) don't
    // each stack their own wrapper - which would dispatch N synthetic events
    // per navigation and produce O(N^2) onLocationChange calls. The wrapper
    // dispatches once; per-instance bookkeeping is done by per-instance
    // listeners that each register/unregister themselves.
    FormoAnalytics.installHistoryHooksOnce();

    this._onPopStateListener = () => this.onLocationChange();
    this._onLocationChangeListener = () => this.onLocationChange();
    window.addEventListener("popstate", this._onPopStateListener);
    window.addEventListener("locationchange", this._onLocationChangeListener);
  }

  /**
   * Wrap history.pushState / replaceState exactly once per `history` object,
   * regardless of how many SDK instances are constructed. Uses a Symbol
   * marker so we recognize our own wrapper across module reloads in HMR.
   */
  private static installHistoryHooksOnce(): void {
    if (typeof history === "undefined" || typeof window === "undefined") return;
    const marker = Symbol.for("formo.historyWrapped");
    if ((history as unknown as Record<symbol, boolean>)[marker]) return;
    (history as unknown as Record<symbol, boolean>)[marker] = true;

    const dispatch = () => window.dispatchEvent(new window.Event("locationchange"));

    const oldPushState = history.pushState;
    history.pushState = function pushState(...args: Parameters<typeof history.pushState>) {
      const ret = oldPushState.apply(this, args);
      dispatch();
      return ret;
    };

    const oldReplaceState = history.replaceState;
    history.replaceState = function replaceState(...args: Parameters<typeof history.replaceState>) {
      const ret = oldReplaceState.apply(this, args);
      dispatch();
      return ret;
    };
  }

  private async trackPageHit(
    category?: string,
    name?: string,
    properties?: IFormoEventProperties,
    context?: IFormoEventContext,
    callback?: (...args: unknown[]) => void
  ): Promise<void> {
    // A route change can end path-based suppression; a provider registered
    // while suppressed gets its refused session adoption retried here.
    // Idempotent and cheap when nothing is pending.
    if (!this.isCleanedUp) {
      try {
        this.evmEvents.retryExternalAdoptions();
      } catch {
        /* never let the retry break a page hit */
      }
    }

    if (!this.shouldTrack()) {
      logger.info(
        "Track page hit: Skipping event due to tracking configuration"
      );
      return;
    }

    setTimeout(() => {
      // Drop in-flight page hits from an SDK instance that was torn down
      // between scheduling and firing (e.g. provider remount in React Strict
      // Mode / HMR). Otherwise the orphan instance would queue a page event
      // here with its stale, never-populated `currentAddress`.
      if (this._pageHooksDisposed) return;
      (async () => {
        try {
          await this.trackEvent(
            EventType.PAGE,
            {
              category,
              name,
            },
            properties,
            context,
            callback
          );
        } catch (e) {
          logger.error("Formo: Failed to track page hit", e);
        }
      })();
    }, 300);
  }

  private async trackEvent(
    type: TEventType,
    payload?: any,
    properties?: IFormoEventProperties,
    context?: IFormoEventContext,
    callback?: (...args: unknown[]) => void
  ): Promise<void> {
    try {
      // Gate on the chain the event actually carries. `connect`, `disconnect`,
      // `chain`, `signature` and `transaction` all put one in the payload, and
      // it is authoritative: it can name a provider or a wagmi mutation chain
      // that is not the active one. Events without a chain (page, track,
      // identify) fall back to the central value.
      if (!this.shouldTrack(payload?.chainId)) {
        logger.info(`Skipping ${type} event due to tracking configuration`);
        return;
      }

      await this.eventManager.addEvent(
        {
          type,
          ...payload,
          properties,
          context,
          callback,
        },
        this.currentAddress,
        this.currentUserId
      );
    } catch (error) {
      logger.error("Error tracking event:", error);
    }
  }

  /**
   * Visitor-level tracking suppression.
   *
   * True when the SDK must not persist identity/session/chain state or send
   * events for this visitor. Public entry points that write state before
   * reaching the `shouldTrack()` gate (identify / connect / detect) check this
   * first, so a suppressed visitor leaves no cookies or session state.
   *
   * The rule lives in `TrackingPolicy`; this stays on the class because it is
   * part of the surface integrations bind to.
   * @internal Also read by `identifyPrivyUser` (via a structural cast) so the
   * Privy sync skips chain reconciliation and emission for suppressed visitors.
   */
  isTrackingSuppressed(): boolean {
    return this.trackingPolicy.isTrackingSuppressed();
  }

  /** @see TrackingPolicy.shouldTrack */
  private shouldTrack(eventChainId?: ChainID): boolean {
    return this.trackingPolicy.shouldTrack({ chainId: eventChainId });
  }

  /**
   * Check if a specific wallet event type is enabled for autocapture
   * @param eventType The wallet event type to check
   * @returns {boolean} True if the event type should be autocaptured
   */
  public isAutocaptureEnabled(eventType: AutocaptureEventType): boolean {
    return this.trackingPolicy.isAutocaptureEnabled(eventType);
  }

  /*
    Utility functions
  */



  get providers(): readonly EIP6963ProviderDetail[] {
    return this.evm.all;
  }


  get provider(): EIP1193Provider | undefined {
    return this._provider;
  }

  /**
   * Access the Solana integration manager.
   * Lazily creates one if not already initialized.
   *
   * @example
   * ```tsx
   * formo.solana.setStore(client.store);
   * formo.solana.setCluster("devnet");
   * // For signatures, use formo.signature() directly
   * ```
   */
  get solana(): SolanaManager {
    if (!this.solanaManager) {
      this.solanaManager = new SolanaManager(this);
    }
    return this.solanaManager;
  }







  private async getCurrentChainId(provider?: EIP1193Provider): Promise<number> {
    const p = provider || this.provider;
    if (!p) {
      logger.error("Provider not set for chain ID");
      return 0;
    }

    let chainIdHex;
    try {
      chainIdHex = await p.request<string>({
        method: "eth_chainId",
      });
      if (!chainIdHex) {
        logger.info("Chain id not found");
        return 0;
      }
      return parseChainId(chainIdHex);
    } catch (err) {
      logger.error("eth_chainId threw an error:", err);
      return 0;
    }
  }







  // Explicitly untrack a provider: remove listeners, clear wrapper flag
  // and tracking

  /**
   * Track an EIP-1193 provider the page constructed itself.
   *
   * Discovery covers EIP-6963 announcements and `window.ethereum`, which is
   * every injected wallet and nothing else. WalletConnect and Ledger
   * providers are built by the app (`EthereumProvider.init(...)`) and
   * announce nothing, so their sessions were invisible: connects,
   * signatures, and transactions all silently missing. Hand the provider
   * here once it exists and it takes the exact pipeline a discovered
   * provider takes - detect event, lifecycle listeners, request wrapper -
   * and a session that is already live is adopted from the provider's
   * synchronous state.
   *
   * Metadata resolution order: the caller's `info` overrides win; then a
   * WalletConnect session's peer metadata, which names the REAL wallet on
   * the far side of the transport (for example "Ledger Live"); then flag
   * sniffing; then a generic fallback. One deliberate exception: a caller
   * name of exactly "WalletConnect" is the generic transport name, so the
   * live peer still replaces it on events - name the provider anything
   * else to pin it verbatim.
   *
   * No-op outside the EIP-1193 path: in wagmi mode the connector system
   * already tracks these sessions, and wrapping the same provider twice
   * would double-report every event.
   *
   * With several live SDK instances (multi write-key pages) registering
   * the SAME provider, request-derived events (signatures, transactions)
   * go to the most recently CREATED live instance, regardless of the
   * order registrations happen to land in - the same single-observer
   * semantics discovery has always had for the request wrapper. Lifecycle events (connect, chain, disconnect) reach every
   * instance. Fanning request observations out to all instances is a
   * separate feature.
   *
   * @returns true when the provider is (now) tracked, false when it was
   * refused (wagmi mode, EVM disabled, or not a valid EIP-1193 provider).
   *
   * @example
   * ```typescript
   * const wcProvider = await EthereumProvider.init({ projectId, chains });
   * formo.registerProvider(wcProvider);
   * ```
   */
  /**
   * INTERNAL. Install the request wrapper on a wagmi connector's provider.
   *
   * Wagmi mode watches the store and caches, which see hook-driven calls
   * only; imperative viem calls (walletClient.sendTransaction,
   * .signMessage, .writeContract, raw request) create no mutation and were
   * silently lost. Every viem client in a wagmi app is built on the
   * connector's EIP-1193 provider, so wrapping that provider closes the
   * gap. Lifecycle (connect/chain/disconnect) stays store-driven: only the
   * request wrapper installs here. Double counting is prevented in the
   * wrapper via `shouldSkipRequestCapture`.
   *
   * `attribution` resolves, live, the name and rdns of the connector this
   * provider was wrapped for. Request-derived events are named from the
   * registry, which for an unannounced provider falls back to flag
   * sniffing; recording the connector's resolver here keeps them in
   * agreement with the hook-driven events for that connector.
   */
  public _wrapWagmiProvider(
    provider: EIP1193Provider,
    chainId?: number,
    attribution?: () => { name: string; rdns?: string } | undefined
  ): boolean {
    if (this.isCleanedUp || !isValidProvider(provider)) return false;
    try {
      // The tracker reports refusals (frozen provider, unrebindable
      // wrapper) by returning false rather than throwing; treat those as
      // failures too so the caller can retry later.
      if (!this.evmRequests.registerRequestListeners(provider)) {
        return false;
      }
      this.evm.rememberAttribution(provider, attribution);
      if (chainId !== undefined) {
        this.evm.rememberChain(provider, chainId);
      }
      return true;
    } catch (e) {
      logger.warn("Failed to wrap wagmi provider for hybrid capture", e);
      return false;
    }
  }

  /** INTERNAL. Chain updates for the fallback-wrapped provider. */
  public _rememberWagmiProviderChain(
    provider: EIP1193Provider,
    chainId: number | undefined
  ): void {
    if (this.isCleanedUp) return;
    try {
      this.evm.rememberChain(provider, chainId);
    } catch {
      /* bookkeeping only */
    }
  }

  public registerProvider(
    provider: EIP1193Provider,
    info?: { name?: string; rdns?: string; icon?: `data:image/${string}` }
  ): boolean {
    if (this.isCleanedUp) {
      // Cleanup terminally closed the event queue; listeners attached now
      // would hold this instance forever and deliver nothing.
      logger.warn("registerProvider: instance is cleaned up; refusing");
      return false;
    }
    if (this.isEvmDisabled) {
      logger.warn("registerProvider: EVM tracking is disabled; refusing");
      return false;
    }
    if (this.isWagmiMode) {
      logger.warn(
        "registerProvider: wagmi mode tracks connectors already; registering the provider here would double-report its events. Refusing."
      );
      return false;
    }
    if (!isValidProvider(provider)) {
      logger.warn("registerProvider: not a valid EIP-1193 provider; refusing");
      return false;
    }

    const detected = detectInjectedProviderInfo(provider);
    const peer = readWalletConnectPeer(provider);
    // A live peer identifies the session as WalletConnect even when the
    // provider carries no isWalletConnect flag (v2 providers often do not).
    const rdns =
      info?.rdns ??
      (peer && detected.rdns === "io.injected.provider"
        ? "com.walletconnect"
        : detected.rdns);
    // The peer name is deliberately NOT stored: sessions change wallets,
    // and metadata frozen at registration would misname every later one.
    // `infoFor` resolves the peer live on each read, over the generic
    // transport name; a caller's explicit name still wins everywhere.
    const name =
      info?.name ?? (peer ? "WalletConnect" : detected.name);

    // Per-instance uuid: EIP-6963 consumers (mipd included) deduplicate on
    // it, so two registered instances sharing an rdns-derived uuid would
    // collapse into one. Random when the platform provides it; a
    // monotonic suffix otherwise.
    const uuid =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `registered-${rdns.replace(/[^a-zA-Z0-9]/g, "-")}-${(FormoAnalytics.registeredProviderSeq += 1)}`;

    return this.evmEvents.adoptExternalProvider({
      info: {
        name,
        rdns,
        uuid,
        icon: info?.icon ?? detected.icon,
      },
      provider: provider as EIP6963ProviderDetail["provider"],
    });
  }

  /** Fallback uuid suffix for platforms without crypto.randomUUID. */
  private static registeredProviderSeq = 0;

  // Debug/monitoring helpers
  public getTrackedProvidersCount(): number {
    return this.evm.counts.trackedProviders;
  }

  /**
   * Get current provider state for debugging
   * @returns Object containing current provider state information
   */
  public getProviderState(): {
    totalProviders: number;
    trackedProviders: number;
    seenProviders: number;
    activeProvider: boolean;
  } {
    return { ...this.evm.counts, activeProvider: !!this._provider };
  }














}
