import { createStore, EIP6963ProviderDetail } from "mipd";
import {
  EVENTS_API_HOST,
  EventType,
  LOCAL_ANONYMOUS_ID_KEY,
  SESSION_USER_ID_KEY,
  SESSION_TRAFFIC_SOURCE_KEY,
  ACTIVE_WALLET_KEY,
  ACTIVE_WALLET_TTL_MS,
  CONSENT_OPT_OUT_KEY,
  TEventType,
} from "./constants";
import { cookie, session, initStorageManager } from "./storage";
import {
  getIdentityCookieDomain,
  getIdentityCookieSecurity,
} from "./storage/cookiePolicy";
import { EventManager, IEventManager } from "./event";
import { EventQueue } from "./queue";
import { logger, Logger } from "./logger";
import {
  setConsentFlag,
  getConsentFlag,
  removeConsentFlag,
} from "./consent";
import { detectInjectedProviderInfo, isValidProvider } from "./provider";
import {
  FormoAnalyticsSession,
  SESSION_WALLET_DETECTED_KEY,
  SESSION_WALLET_IDENTIFIED_KEY,
} from "./session";
import {
  Address,
  ChainID,
  ChainNamespace,
  ChainState,
  Config,
  EIP1193Provider,
  EvmChainState,
  IFormoAnalytics,
  IFormoEventContext,
  IFormoEventProperties,
  Options,
  RequestArguments,
  RPCError,
  SignatureStatus,
  TransactionStatus,
  ConnectInfo,
  WrappedEIP1193Provider,
  WrappedRequestFunction,
  WRAPPED_REQUEST_SYMBOL,
  WRAPPED_REQUEST_REF_SYMBOL,
} from "./types";
import { validateAddress, validateAndChecksumAddress } from "./utils/address";
import {
  AutocaptureEventType,
  ITrackingPolicy,
  TrackingPolicy,
} from "./tracking";
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
const PROVIDER_SWITCH_REASONS = {
  ADDRESS_MISMATCH: "Address mismatch indicates wallet switch",
  NO_ACCOUNTS: "Current provider has no accounts",
  CHECK_FAILED: "Could not check current provider accounts",
} as const;

export class FormoAnalytics implements IFormoAnalytics {
  // Per-chain namespace state - isolates EVM and Solana connection state
  private _chainState: { evm: EvmChainState; solana: ChainState } = {
    evm: {},
    solana: {},
  };
  private _activeNamespace?: ChainNamespace;

  // EVM state accessors - EVM listener paths must use these instead of
  // currentAddress/currentChainId to avoid cross-namespace reads.
  private get _provider(): EIP1193Provider | undefined {
    return this._chainState.evm.provider;
  }
  /**
   * Drop a provider's reported-connect record when it stops being active.
   *
   * The active provider is displaced from several places, and not all of them
   * go through the `_provider` setter: `setChainState()` writes
   * `_chainState.evm.provider` directly and `clearChainState()` replaces the
   * whole namespace. Guarding only the setter left A's record alive across a
   * real A-to-B switch, so returning to A was suppressed.
   */
  private forgetConnectRecord(
    previous: EIP1193Provider | undefined,
    next: EIP1193Provider | undefined
  ): void {
    if (previous && previous !== next) {
      this._announcedConnect.delete(previous);
    }
  }

  private set _provider(value: EIP1193Provider | undefined) {
    const previous = this._chainState.evm.provider;
    // A provider that stops being the active one has, from this SDK's point of
    // view, ended its connection - so the connect it reported must stop
    // counting. Otherwise toggling between two installed wallets silently
    // loses every connect after the first: A's stale record suppresses the
    // connect when the user comes back to it.
    //
    // Done in the setter rather than at each switch site because the active
    // provider is reassigned from several paths - `accountsChanged`,
    // `chainChanged`, `connect`, `handleProviderMismatch`, `untrackProvider` -
    // and any one of them missed would reopen the same hole.
    this.forgetConnectRecord(previous, value);
    this._chainState.evm.provider = value;
  }
  private get _evmAddress(): Address | undefined {
    return this._chainState.evm.address;
  }
  private get _evmChainId(): ChainID | undefined {
    return this._chainState.evm.chainId;
  }

  /**
   * Last known chain per tracked provider, fed by `chainChanged` / `connect`
   * and by a one-off probe at tracking time. Read synchronously when labelling
   * an autocaptured event, so the wallet's request transport is never used for
   * analytics. Weak so an untracked provider can be collected.
   */
  /**
   * The connect this SDK has actually REPORTED for a provider.
   *
   * Deduplicating on "is an address known" was wrong in both directions.
   * `onConnected` and `onAccountsChanged` both observe one connection, so
   * something has to stop them double-reporting - but an address can be
   * present without a connect ever having been sent: restored from the
   * active-wallet cookie, or reported with an unresolved chain and then
   * refused by `tracking.excludeChains`. Suppressing on address presence lost
   * the connect entirely in those cases.
   *
   * Records what was reported, so a later event can be recognised as a
   * genuine improvement on it rather than a duplicate.
   */
  private _announcedConnect = new WeakMap<
    EIP1193Provider,
    { address: string; chainId: number }
  >();

  /**
   * Monotonic generation per namespace, bumped whenever a wallet claims it.
   *
   * Address and provider alone cannot tell "this session never changed"
   * apart from "the same wallet disconnected and reconnected", because both
   * leave identical state. The generation can, which is what lets a slow
   * disconnect know it is stale.
   *
   * Kept per namespace rather than per provider so it also covers Solana,
   * which has no EIP-1193 provider to hang a stamp on, and so that a wallet
   * arriving on a different provider still moves it.
   */
  private _sessionSeq: Record<ChainNamespace, number> = { evm: 0, solana: 0 };

  private _providerChainIds = new WeakMap<EIP1193Provider, number>();

  /**
   * How many disconnects a provider has begun. Ordering, not presence.
   *
   * A wallet can emit `connect` and then `accountsChanged([])` back to back.
   * The connect handler is still resolving the address when the disconnect
   * starts, and its late continuation would otherwise claim the namespace -
   * which the disconnect then reads as a reconnect, so it skips its cleanup
   * and the departed wallet stays attached to every later event.
   *
   * A plain "is disconnecting" flag cannot express this: a genuine reconnect
   * that arrives DURING the disconnect must still be reported. What separates
   * the two is whether the connect observation began before the disconnect
   * did, which is exactly what comparing this count across the await tells us.
   */
  private _disconnectEpoch = new WeakMap<EIP1193Provider, number>();

  /**
   * Bumped on every chain observation, PER PROVIDER. An `eth_chainId` answer
   * that resolves after a newer observation for the same provider must not
   * overwrite it.
   *
   * Deliberately per provider, not per SDK instance: a global counter meant
   * any activity on wallet B discarded a perfectly valid in-flight answer for
   * wallet A, leaving A at chain 0 - and, since an unresolved chain fails
   * closed, dropping all of A's events whenever `excludeChains` is set.
   */
  private _providerChainGenerations = new WeakMap<EIP1193Provider, number>();

  private _providerListenersMap: Map<
    EIP1193Provider,
    Record<string, (...args: unknown[]) => void>
  > = new Map();
  private session: FormoAnalyticsSession;
  private eventManager: IEventManager;
  /** Every "may we track this?" rule. See src/tracking/TrackingPolicy.ts. */
  private trackingPolicy: ITrackingPolicy;
  /**
   * EIP-6963 provider details discovered through the browser
   * This array contains all available providers with their metadata
   */
  private _providers: readonly EIP6963ProviderDetail[] = [];

  /**
   * Set of providers that have been tracked with event listeners
   * This is separate from _providers because:
   * - _providers contains all discovered providers (EIP-6963)
   * - _trackedProviders contains only providers that have been set up with listeners
   * - A provider can be discovered but not yet tracked (e.g., during initialization)
   * - A provider can be tracked but later removed from discovery
   */
  private _trackedProviders: Set<EIP1193Provider> = new Set();

  // Cache for injected provider detection to avoid redundant operations
  private _injectedProviderDetail?: EIP6963ProviderDetail;

  // Flag to prevent concurrent processing of accountsChanged events
  private _processingAccountsChanged: boolean = false;

  // Set to efficiently track seen providers for deduplication and O(1) lookup
  private _seenProviders: Set<EIP1193Provider> = new Set();

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
  currentChainId?: ChainID;
  currentAddress?: Address;
  currentUserId?: string = "";

  /**
   * Helper method to check if a provider is different from the currently active one
   * @param provider The provider to check
   * @returns true if there's a provider mismatch, false otherwise
   */
  private isProviderMismatch(provider: EIP1193Provider): boolean {
    // Only consider it a mismatch if we have an active provider AND the provider is different
    // This allows legitimate provider switching while preventing race conditions
    return this._provider != null && this._provider !== provider;
  }

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

    this.trackingPolicy = new TrackingPolicy(options, {
      hasOptedOut: () => this.hasOptedOutTracking(),
      // Read lazily: the central chain moves as wallets connect and switch,
      // so the policy must see it at decision time, not at construction.
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
        this.trackEIP1193Provider(provider);
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
    this.loadActiveWallet();

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
      analytics._providers = await analytics.getProviders();
      await analytics.detectWallets(analytics._providers);
      analytics.trackProviders(analytics._providers);
    } else {
      logger.info("FormoAnalytics: Skipping provider detection (Wagmi mode)");
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
   * Reset the current user session.
   * @returns {void}
   */
  public reset(): void {
    this.currentUserId = undefined;

    // Clear in-memory wallet identity too. Without this, a logout/reset
    // (also triggered by optOutTracking) still leaks the previous wallet
    // address on subsequent track()/page() events for the rest of the
    // page lifetime, because they fall back to currentAddress. Keep the
    // EVM provider reference so tracking can resume on the next connect.
    this.currentAddress = undefined;
    this.currentChainId = undefined;
    const evmProvider = this._chainState.evm.provider;
    this._chainState = { evm: { provider: evmProvider }, solana: {} };
    this._activeNamespace = undefined;

    cookie().remove(LOCAL_ANONYMOUS_ID_KEY);
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
  public cleanup(): void {
    logger.debug("FormoAnalytics: Cleaning up resources");

    // Close the queue, don't just empty it. clear() only drops what is
    // buffered at this instant; asynchronous work already in flight (event
    // creation is async on every emit path) would still enqueue afterwards,
    // and an empty queue flushes immediately. close() is terminal, so a
    // continuation that outlives this instance cannot send with its stale
    // options. See issue #339.
    this.eventManager.close();

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
      for (const provider of Array.from(this._trackedProviders)) {
        this.untrackProvider(provider);
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

    // A new wallet now owns this namespace. Anything that was already
    // tearing down the previous session must not undo this.
    this._sessionSeq[this.getNamespace(chainId)]++;

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
    const namespace = this.getNamespace(chainId);
    const beforeSeq = this._sessionSeq[namespace];

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
    if (this._sessionSeq[namespace] !== beforeSeq) {
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
      if (this.isTrackingSuppressed() || this.isCurrentChainExcluded()) {
        logger.info(
          "identify() skipped: tracking is suppressed for this visitor, environment, or chain"
        );
        return;
      }
      if (!params) {
        // If no params provided, auto-identify
        logger.info(
          "Auto-identifying with providers:",
          this._providers.map((p) => p.info.name)
        );
        for (const providerDetail of this._providers) {
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
        this.currentAddress = validAddress;
        this.persistActiveWallet();
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
      this.currentChainId = undefined;
      this.persistActiveWallet();
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
    this.reset();

    logger.info("Successfully opted out of tracking");
  }

  /**
   * Opt back into tracking after previously opting out. This will re-enable analytics tracking
   * and switch back to persistent storage.
   * @returns {void}
   */
  public optInTracking(): void {
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

  /**
   * Track an EIP-1193 provider by wrapping its request method and adding event listeners
   * Note: This is only used in non-Wagmi mode. When Wagmi is enabled, all tracking
   * happens through Wagmi's connector system instead of EIP-1193/EIP-6963.
   * @param provider The EIP-1193 provider to track
   */
  private trackEIP1193Provider(provider: EIP1193Provider): void {
    logger.info("trackEIP1193Provider", provider);
    
    // Defensive check: Skip provider tracking in Wagmi mode
    // This should never be called in Wagmi mode due to guards in init(),
    // but we check here for safety in case of future code changes
    if (this.isWagmiMode) {
      logger.debug("trackEIP1193Provider: Skipping EIP-1193 provider tracking (Wagmi mode - using connector system instead)");
      return;
    }
    
    try {
      // Validate provider exists and has required methods
      if (!isValidProvider(provider)) {
        logger.warn("trackEIP1193Provider: Invalid provider - missing required methods");
        return;
      }
      
      if (this._trackedProviders.has(provider)) {
        logger.warn("trackEIP1193Provider: Provider already tracked");
        return;
      }

      // CRITICAL: Always register accountsChanged for state management
      // This ensures currentAddress, currentChainId, and _provider are always up-to-date
      // Event emission is controlled conditionally inside the handlers
      this.registerAccountsChangedListener(provider);

      // `chainChanged` and `connect` are registered UNCONDITIONALLY: they are
      // how this provider's chain is observed, and every signature and
      // transaction has to be labelled with it. Gating registration on
      // `autocapture.chain` conflated observing a chain with reporting one, so
      // `{ chain: false, signature: true }` left the chain frozen at whatever
      // was first seen - a switch to an excluded chain went unnoticed and its
      // signatures were emitted under the old, allowed chain. Whether an
      // event is emitted is decided inside each handler.
      this.registerChainChangedListener(provider);
      if (this.isAutocaptureEnabled("connect")) {
        this.registerConnectListener(provider);
      } else {
        // Observation only. The full connect handler calls `getAddress()`,
        // which issues `eth_accounts`, and nothing analytics-only may go on
        // the wallet's transport - a stalled request there sits in front of
        // the next signature the dapp makes. The chain rides along on the
        // event itself, so it costs nothing to record.
        this.registerConnectChainObserver(provider);
      }

      // Seed the chain from the provider's own synchronous state if it exposes
      // one. Deliberately a property read and never an RPC: see
      // resolveChainIdForProvider for why nothing analytics-only may go on the
      // wallet's transport.
      this.seedProviderChainFromState(provider);

      if (this.isAutocaptureEnabled("signature") || this.isAutocaptureEnabled("transaction")) {
        this.registerRequestListeners(provider);
      } else {
        logger.debug("TrackProvider: Skipping request wrapping (both signature and transaction autocapture disabled)");
      }

      // Registered UNCONDITIONALLY: this listener also ends the provider's
      // reported-connect record, and with `{ connect: true, disconnect: false }`
      // a wallet that disconnected and reconnected would otherwise find its
      // old record still standing and have the new connect suppressed. Whether
      // a disconnect EVENT is emitted is decided inside the handler.
      {
        this.registerDisconnectListener(provider);
      }

      // Only add to tracked providers after all listeners are successfully registered
      this._trackedProviders.add(provider);
    } catch (error) {
      logger.error("Error tracking provider:", error);
    }
  }

  private trackProviders(providers: readonly EIP6963ProviderDetail[]): void {
    try {
      for (const eip6963ProviderDetail of providers) {
        const provider = eip6963ProviderDetail?.provider as
          | EIP1193Provider
          | undefined;
        if (provider && !this._trackedProviders.has(provider)) {
          this.trackEIP1193Provider(provider);
        }
      }
    } catch (error) {
      logger.error(
        "Failed to track EIP-6963 providers during initialization:",
        error
      );
    }
  }

  private addProviderListener(
    provider: EIP1193Provider,
    event: string,
    listener: (...args: unknown[]) => void
  ): void {
    const map = this._providerListenersMap.get(provider) || {};
    map[event] = listener;
    this._providerListenersMap.set(provider, map);
  }

  private registerAccountsChangedListener(provider: EIP1193Provider): void {
    logger.info("registerAccountsChangedListener");
    const listener = (...args: unknown[]) =>
      this.onAccountsChanged(provider, args[0] as string[]);

    provider.on("accountsChanged", listener);
    this.addProviderListener(provider, "accountsChanged", listener);
  }

  private async onAccountsChanged(
    provider: EIP1193Provider,
    accounts: string[]
  ): Promise<void> {
    logger.info("onAccountsChanged", accounts);

    // Prevent concurrent processing of accountsChanged events to avoid race conditions
    if (this._processingAccountsChanged) {
      logger.debug(
        "OnAccountsChanged: Already processing accountsChanged, skipping",
        {
          provider: this.getProviderInfo(provider).name,
        }
      );
      return;
    }

    this._processingAccountsChanged = true;

    try {
      await this._handleAccountsChanged(provider, accounts);
    } finally {
      this._processingAccountsChanged = false;
    }
  }

  /**
   * Handles changes to the accounts of a given EIP-1193 provider.
   *
   * @param provider - The EIP-1193 provider whose accounts have changed.
   * @param accounts - The new array of account addresses. An empty array indicates a disconnect.
   * @returns A promise that resolves when the account change has been processed.
   *
   * If the accounts array is empty and the provider is the active provider, this method triggers
   * a disconnect flow. Otherwise, it updates the state to reflect the new accounts as needed.
   */
  private async _handleAccountsChanged(
    provider: EIP1193Provider,
    accounts: string[]
  ): Promise<void> {
    if (accounts.length === 0) {
      // Handle wallet disconnect for active provider only
      if (this._provider === provider) {
        logger.info("OnAccountsChanged: Detecting disconnect, current state:", {
          evmAddress: this._evmAddress,
          evmChainId: this._evmChainId,
          providerMatch: this._provider === provider,
        });

        // The reported connect ends with the connection, so a genuine
        // reconnect later reports again rather than being taken for a
        // duplicate.
        this._announcedConnect.delete(provider);
        this.beginProviderDisconnect(provider);

        // Check if disconnect tracking is enabled before emitting event
        if (this.isAutocaptureEnabled("disconnect")) {
          try {
            // Pass EVM state explicitly to ensure we have the data for the disconnect event
            await this.disconnect({
              chainId: this._evmChainId,
              address: this._evmAddress,
            });
            // Provider remains tracked to allow for reconnection scenarios
          } catch (error) {
            logger.error(
              "Failed to disconnect provider on accountsChanged",
              error
            );
            // Don't untrack if disconnect failed to maintain state consistency
          }
        } else {
          logger.debug("OnAccountsChanged: Disconnect event skipped (autocapture.disconnect: false)");
          // Still clear state even if not tracking the event
          this.clearChainState('evm');
        }
      } else {
        logger.info(
          "OnAccountsChanged: Ignoring disconnect for non-active provider"
        );
      }
      return;
    }

    // Validate and checksum the first account address
    const address = validateAndChecksumAddress(accounts[0]);
    if (!address) {
      logger.warn("onAccountsChanged: Invalid address received", accounts[0]);
      return;
    }

    // Handle provider switching: if we have an active provider but a different provider
    // is connecting with accounts, check if the current provider is still connected
    if (this._provider && this._provider !== provider) {
      // Emitting the old wallet's disconnect is asynchronous, and a third
      // provider can claim the namespace during it (a `chainChanged` counts
      // as a wallet switch, so it does not need this handler at all). This
      // transition is then stale: installing it would overwrite a newer,
      // already-reported session. See issue #344.
      const seqBeforeSwitch = this._sessionSeq.evm;
      // Every branch below tears down whichever provider is active now, so
      // its in-flight connect observations must stop counting from here.
      this.beginProviderDisconnect(this._provider);
      // Capture current EVM state BEFORE any changes
      const currentStoredAddress = this._evmAddress;
      const newProviderAddress = validateAndChecksumAddress(address);

      logger.info(
        "OnAccountsChanged: Different provider attempting to connect",
        {
          activeProvider: this.getProviderInfo(this._provider).name,
          eventProvider: this.getProviderInfo(provider).name,
          currentStoredAddress: currentStoredAddress,
          newProviderAddress: newProviderAddress,
        }
      );

      // Check if current active provider still has accounts
      try {
        const activeProviderAccounts = await this.getAccounts(this._provider);

        // The probe is asynchronous too, so check before issuing anything.
        // Every branch below reads `this._evmAddress` / `this._evmChainId`,
        // so a switch that went stale during the probe would emit a false
        // disconnect for whoever claimed the namespace, and clear them.
        if (this.isStaleEvmTransition(seqBeforeSwitch)) return;

        logger.info("OnAccountsChanged: Checking current provider accounts", {
          activeProvider: this.getProviderInfo(this._provider).name,
          accountsLength: activeProviderAccounts
            ? activeProviderAccounts.length
            : 0,
          accounts: activeProviderAccounts,
        });

        if (activeProviderAccounts && activeProviderAccounts.length > 0) {
          // Check if the new provider has a different address - this indicates a real wallet switch
          if (
            newProviderAddress &&
            currentStoredAddress &&
            newProviderAddress !== currentStoredAddress
          ) {
            logger.info(
              "OnAccountsChanged: Different address detected, switching providers despite current provider having accounts",
              {
                activeProvider: this.getProviderInfo(this._provider).name,
                eventProvider: this.getProviderInfo(provider).name,
                currentAddress: currentStoredAddress,
                newAddress: newProviderAddress,
                reason: PROVIDER_SWITCH_REASONS.ADDRESS_MISMATCH,
              }
            );

            // Emit disconnect for the old provider if tracking is enabled
            if (this.isAutocaptureEnabled("disconnect")) {
              await this.disconnect({
                chainId: this._evmChainId,
                address: this._evmAddress,
              });
            } else {
              logger.debug("OnAccountsChanged: Disconnect event skipped during provider switch (autocapture.disconnect: false)");
              // Still clear state even if not tracking the event
              this.clearChainState('evm');
            }

            if (this.isStaleEvmTransition(seqBeforeSwitch)) return;

            // Clear state and let the new provider become active
            this.clearActiveProvider();
          } else {
            logger.info(
              "OnAccountsChanged: Current provider still has accounts and same address, ignoring new provider",
              {
                activeProvider: this.getProviderInfo(this._provider).name,
                eventProvider: this.getProviderInfo(provider).name,
                activeProviderAccountsCount: activeProviderAccounts.length,
                currentAddress: currentStoredAddress,
                newAddress: newProviderAddress,
              }
            );
            return;
          }
        } else {
          logger.info(
            "OnAccountsChanged: Current provider has no accounts, switching to new provider",
            {
              oldProvider: this.getProviderInfo(this._provider).name,
              newProvider: this.getProviderInfo(provider).name,
              reason: PROVIDER_SWITCH_REASONS.NO_ACCOUNTS,
            }
          );

          // Emit disconnect for the old provider that didn't signal properly if tracking is enabled
          if (this.isAutocaptureEnabled("disconnect")) {
            await this.disconnect({
              chainId: this._evmChainId,
              address: this._evmAddress,
            });
          } else {
            logger.debug("OnAccountsChanged: Disconnect event skipped for old provider (autocapture.disconnect: false)");
            // Still clear state even if not tracking the event
            this.clearChainState('evm');
          }

          if (this.isStaleEvmTransition(seqBeforeSwitch)) return;
        }
      } catch (error) {
        logger.warn(
          "OnAccountsChanged: Could not check current provider accounts, switching to new provider",
          {
            error: error instanceof Error ? error.message : String(error),
            errorType:
              error instanceof Error ? error.constructor.name : typeof error,
            oldProvider: this._provider
              ? this.getProviderInfo(this._provider).name
              : "unknown",
            newProvider: this.getProviderInfo(provider).name,
            reason: PROVIDER_SWITCH_REASONS.CHECK_FAILED,
          }
        );

        // If we can't check the current provider, assume it's disconnected
        if (this.isAutocaptureEnabled("disconnect")) {
          await this.disconnect({
            chainId: this._evmChainId,
            address: this._evmAddress,
          });
        } else {
          logger.debug("OnAccountsChanged: Disconnect event skipped for failed provider check (autocapture.disconnect: false)");
          // Still clear state even if not tracking the event
          this.clearChainState('evm');
        }

        if (this.isStaleEvmTransition(seqBeforeSwitch)) return;
      }
    }

    // Set provider if none exists (first connection)
    if (!this._provider) {
      this._provider = provider;
    }

    // If both the provider and address are the same, no-op
    if (this._provider === provider && address === this._evmAddress) {
      return;
    }

    // Read the chain from what has already been observed. NO RPC.
    //
    // This path used to call `eth_chainId`, which is the same hazard the
    // request paths had removed: on a transport that serializes - a
    // WalletConnect relay socket - a stalled analytics lookup sits in the
    // wallet's queue ahead of the dapp's next signature. `accountsChanged`
    // fires exactly when a user is about to transact, so it is the worst
    // moment to occupy that queue.
    //
    // A provider that has announced nothing yet reports 0 ("unknown"), which
    // the exclusion gate refuses rather than guessing at.
    const nextChainId = this.resolveChainIdForProvider(provider);
    const wasDisconnected = !this._evmAddress;

    // Update state regardless of whether connect *event* tracking is enabled,
    // so disconnect events keep valid address/chainId values. (excludeChains is
    // NOT suppression - it still updates state so currentChainId can gate
    // events.)
    if (this.isTrackingSuppressed()) {
      this.clearStaleEvmWalletOnSwitchWhileSuppressed(address);
    } else {
      this.setChainState('evm', { address, chainId: nextChainId });
    }

    // Conditionally emit connect event based on tracking configuration
    const providerInfo = this.getProviderInfo(provider);
    const effectiveChainId = nextChainId || 0;
    
    if (
      this.isAutocaptureEnabled("connect") &&
      this.shouldReportConnect(provider, address)
    ) {
      logger.info(
        "OnAccountsChanged: Detected wallet connection, emitting connect event",
        {
          chainId: nextChainId,
          address,
          wasDisconnected,
          providerName: providerInfo.name,
          rdns: providerInfo.rdns,
          hasChainId: !!nextChainId,
        }
      );

      if (effectiveChainId === 0) {
        logger.info(
          "OnAccountsChanged: Using fallback chainId 0 for connect event"
        );
      }

      this.markConnectReported(provider, address, effectiveChainId);
      this.connect(
        {
          chainId: effectiveChainId,
          address,
        },
        {
          providerName: providerInfo.name,
          rdns: providerInfo.rdns,
        }
      ).catch((error) => {
        logger.error(
          "Failed to track connect event during account change:",
          error
        );
      });
    } else {
      logger.debug(
        "OnAccountsChanged: Connect event skipped (autocapture.connect: false)",
        {
          chainId: nextChainId,
          address,
          providerName: providerInfo.name,
        }
      );
    }
  }

  private registerChainChangedListener(provider: EIP1193Provider): void {
    logger.info("registerChainChangedListener");
    const listener = (...args: unknown[]) =>
      this.onChainChanged(provider, args[0] as string);
    provider.on("chainChanged", listener);
    this.addProviderListener(provider, "chainChanged", listener);
  }

  private async onChainChanged(
    provider: EIP1193Provider,
    chainIdHex: string
  ): Promise<void> {
    logger.info("onChainChanged", chainIdHex);

    const nextChainId = parseChainId(chainIdHex);

    // Record it for THIS provider regardless of which one is active. This is
    // the only way an autocaptured event from a non-active wallet can learn
    // its chain without putting an RPC on that wallet's transport.
    this.rememberProviderChain(provider, nextChainId);

    // Beyond that, a chain event from a NON-active provider is observation
    // only when chain autocapture is off.
    //
    // This listener is now registered unconditionally, so that a signature can
    // be labelled with its signer's chain. `handleProviderMismatch()` treats a
    // chain event from another wallet as a wallet switch and clears the active
    // wallet's address and chain. That is the established behaviour of the
    // chain feature and stays exactly as it was, but it must not start firing
    // for apps that never asked for chain tracking: a second wallet switching
    // network would silently erase the active wallet's attribution.
    // Observation only when chain autocapture is off, whether or not an
    // active provider has been established yet.
    //
    // `isProviderMismatch()` is false while `_provider` is undefined, which is
    // exactly the state left by restoring a wallet from the active-wallet
    // cookie. A background wallet's `chainChanged` could therefore claim the
    // active slot and overwrite the restored wallet's chain - suppressing
    // allowed events, or letting excluded ones through. The active provider is
    // established by an actual account/connect/request association, not by
    // another wallet changing network.
    if (!this.isAutocaptureEnabled("chain") && provider !== this._provider) {
      return;
    }

    // Only handle chain changes for the active provider (or if none is set yet)
    if (this.isProviderMismatch(provider)) {
      this.handleProviderMismatch(provider);
    }

    // Chain changes only matter for connected users
    if (!this._evmAddress) {
      logger.info(
        "OnChainChanged: No current address, user appears disconnected"
      );
      return Promise.resolve();
    }

    // Set provider if none exists
    if (!this._provider) {
      this._provider = provider;
    }

    this.setChainState('evm', { chainId: nextChainId });

    try {
      // This is just a chain change since we already confirmed _evmAddress exists
      if (this.isAutocaptureEnabled("chain")) {
        // Awaited, so a failing emission is caught below rather than escaping
        // as an unhandled rejection out of the provider's event listener.
        // `return`ing the promise left the catch here unreachable.
        await this.chain({
          chainId: nextChainId,
          address: this._evmAddress,
        });
      } else {
        logger.debug("OnChainChanged: Chain event skipped (autocapture.chain: false)", {
          chainId: this._evmChainId,
          address: this._evmAddress,
        });
      }
    } catch (error) {
      logger.error("OnChainChanged: Failed to emit chain event:", error);
    }
  }

  /**
   * Record a provider's chain from its `connect` event, and nothing else.
   *
   * Used when connect autocapture is off. `connect` carries `chainId` in its
   * payload, so this needs no RPC - unlike the full handler, which resolves
   * the account.
   */
  private registerConnectChainObserver(provider: EIP1193Provider): void {
    const listener = (...args: unknown[]) => {
      const connection = args[0] as { chainId?: unknown } | undefined;
      if (typeof connection?.chainId !== "string") return;
      this.rememberProviderChain(provider, parseChainId(connection.chainId));
    };
    provider.on("connect", listener);
    this.addProviderListener(provider, "connect", listener);
  }

  /**
   * Whether a connect for this wallet still needs reporting.
   *
   * True when nothing has been reported for this provider, or when the account
   * changed. A wallet already reported is not reported again.
   *
   * Deliberately does NOT re-report to correct a chain. When `accountsChanged`
   * wins the race on a provider that exposes no synchronous `chainId`, the
   * connect carries 0 - honestly, since the chain is unknown at that instant -
   * and the `connect` payload that follows knows the real one. Emitting again
   * to relabel would mean two connects for one connection, which is the bug
   * this whole path exists to prevent. That payload still corrects
   * `currentChainId`, so everything after it is attributed properly.
   */
  private shouldReportConnect(
    provider: EIP1193Provider,
    address: Address
  ): boolean {
    const reported = this._announcedConnect.get(provider);
    if (!reported) return true;
    return reported.address.toLowerCase() !== address.toLowerCase();
  }

  /**
   * Record a connect as reported - but only if it will actually be sent.
   *
   * `connect()` passes through `shouldTrack()`, which refuses an unresolvable
   * chain when `tracking.excludeChains` is configured. Marking a refused event
   * as reported would suppress the authoritative one that follows.
   */
  private markConnectReported(
    provider: EIP1193Provider,
    address: Address,
    chainId: number
  ): void {
    if (!this.willTrackEvent(chainId)) return;
    this._announcedConnect.set(provider, { address, chainId });
  }

  private registerConnectListener(provider: EIP1193Provider): void {
    logger.info("registerConnectListener");
    const listener = (...args: unknown[]) => {
      const connection: ConnectInfo = args[0] as ConnectInfo;
      this.onConnected(provider, connection);
    };
    provider.on("connect", listener);
    this.addProviderListener(provider, "connect", listener);
  }

  private registerDisconnectListener(provider: EIP1193Provider): void {
    logger.info("registerDisconnectListener");
    const listener = async (_error?: unknown) => {
      if (this._provider !== provider) return;
      // As in the accountsChanged disconnect path: the reported connect ends
      // with the connection.
      this._announcedConnect.delete(provider);
      logger.info(
        "OnDisconnect: Wallet disconnect event received, current state:",
        {
          currentAddress: this._evmAddress,
          currentChainId: this._evmChainId,
        }
      );

      this.beginProviderDisconnect(provider);

      // Double-check disconnect tracking is enabled (defensive programming)
      // Note: This listener should only be registered if tracking is enabled
      if (this.isAutocaptureEnabled("disconnect")) {
        try {
          // Pass current state explicitly to ensure we have the data for the disconnect event
          await this.disconnect({
            chainId: this._evmChainId,
            address: this._evmAddress,
          });
          // Provider remains tracked to allow for reconnection scenarios
        } catch (e) {
          logger.error("Error during disconnect in disconnect listener", e);
          // Don't untrack if disconnect failed to maintain state consistency
        }
      } else {
        logger.debug("OnDisconnect: Disconnect event skipped (autocapture.disconnect: false)");
        // Still clear state even if not tracking the event
        this.clearChainState('evm');
      }
    };
    provider.on("disconnect", listener);
    this.addProviderListener(provider, "disconnect", listener);
  }

  private async onConnected(
    provider: EIP1193Provider,
    connection: ConnectInfo
  ): Promise<void> {
    logger.info("onConnected", connection);

    // Taken before any await, so it reflects the state this observation
    // actually saw.
    const disconnectEpoch = this._disconnectEpoch.get(provider) ?? 0;

    try {
      if (!connection?.chainId || typeof connection.chainId !== "string")
        return;

      const chainId = parseChainId(connection.chainId);
      // Record it for this provider before anything can bail out below.
      this.rememberProviderChain(provider, chainId);
      const address = await this.getAddress(provider);

      // The wallet went away after this observation began. Claiming the
      // namespace now would make the disconnect still in flight look stale,
      // so it would skip its cleanup. A reconnect that started AFTER the
      // disconnect sees an unchanged count here and is reported normally.
      if ((this._disconnectEpoch.get(provider) ?? 0) !== disconnectEpoch) {
        logger.info(
          "onConnected: This provider is disconnecting; dropping a connect observation that the disconnect has overtaken"
        );
        return;
      }

      if (chainId && address) {
        // Check if this is a connection event (transition from no address to having an address)
        const wasDisconnected = !this._evmAddress;

        // Set provider if none exists
        if (!this._provider) {
          this._provider = provider;
        }

        // Only emit connect event for the active provider to avoid duplicates
        // Check if this provider is the currently active one
        const isActiveProvider = this._provider === provider;

        // Update state from active provider so disconnect events keep valid
        // address/chainId values - except while suppressed, where we must not
        // LEARN identity (only drop a stale EVM wallet on a switch).
        if (isActiveProvider) {
          if (this.isTrackingSuppressed()) {
            this.clearStaleEvmWalletOnSwitchWhileSuppressed(address);
          } else {
            this.setChainState('evm', {
              chainId,
              address: validateAndChecksumAddress(address) || undefined,
            });
          }
        }

        // Conditionally emit connect event based on tracking configuration.
        //
        // Both handlers observe one connection, so `shouldReportConnect()`
        // decides which of them reports it. It keys on what was actually
        // REPORTED, not on whether an address is known: an address can be
        // present with no connect ever sent - restored from the active-wallet
        // cookie, or reported with an unresolved chain and then refused by
        // `excludeChains` - and this payload carries the authoritative chain,
        // so it must be able to supersede such a report.
        if (
          isActiveProvider &&
          this._evmAddress &&
          this.shouldReportConnect(provider, address)
        ) {
          const providerInfo = this.getProviderInfo(provider);
          const effectiveChainId = chainId || 0;

          if (this.isAutocaptureEnabled("connect")) {
            logger.info(
              "OnConnected: Detected wallet connection, emitting connect event",
              {
                chainId,
                wasDisconnected,
                providerName: providerInfo.name,
                rdns: providerInfo.rdns,
                hasChainId: !!chainId,
                isActiveProvider,
              }
            );

            if (effectiveChainId === 0) {
              logger.info(
                "OnConnected: Using fallback chainId 0 for connect event"
              );
            }

            this.markConnectReported(provider, address, effectiveChainId);
            this.connect(
              {
                chainId: effectiveChainId,
                address,
              },
              {
                providerName: providerInfo.name,
                rdns: providerInfo.rdns,
              }
            ).catch((error) => {
              logger.error(
                "Failed to track connect event during provider connection:",
                error
              );
            });
          } else {
            logger.debug(
              "OnConnected: Connect event skipped (autocapture.connect: false)",
              {
                chainId,
                address,
                providerName: providerInfo.name,
              }
            );
          }
        } else if (address && !isActiveProvider) {
          const providerInfo = this.getProviderInfo(provider);
          logger.debug(
            "OnConnected: Skipping connect event for non-active provider",
            {
              chainId,
              providerName: providerInfo.name,
              rdns: providerInfo.rdns,
              isActiveProvider,
              activeProviderInfo: this._provider
                ? this.getProviderInfo(this._provider)
                : null,
            }
          );
        }
      }
    } catch (e) {
      logger.error("Error handling connect event", e);
    }
  }

  private registerRequestListeners(provider: EIP1193Provider): void {
    logger.info("registerRequestListeners");
    if (!provider) {
      logger.error(
        "Provider not found for request (signature, transaction) tracking"
      );
      return;
    }

    // Check if the provider is already wrapped with our SDK's wrapper
    const currentRequest = provider.request as WrappedRequestFunction;
    if (this.isProviderAlreadyWrapped(provider, currentRequest)) {
      logger.info(
        "Provider already wrapped with our SDK; skipping request wrapping."
      );
      return;
    }

    const request = provider.request.bind(provider);

    const wrappedRequest: WrappedRequestFunction = async <T>({
      method,
      params,
    }: RequestArguments): Promise<T | null | undefined> => {
      // Learn the chain from a call the APP was making anyway.
      //
      // A standards-compliant provider need not expose a synchronous `chainId`
      // property, and if it connected before the SDK initialised, its
      // `connect` event is never replayed. Such a provider stayed unknown -
      // reported as chain 0, and with `excludeChains` configured its events
      // were dropped even on an allowed chain. This adds no request of its
      // own; it only reads the answer to one the dapp already sent.
      if (method === "eth_chainId") {
        // Snapshot rather than advance. Advancing at request time meant a
        // second lookup that went on to FAIL still invalidated the first
        // one's perfectly good answer, leaving the provider unknown.
        // `rememberProviderChain()` advances it when an observation is
        // actually accepted.
        const generation = this._providerChainGenerations.get(provider) ?? 0;
        return request({ method, params }).then((result) => {
          // A `chainChanged` for THIS provider may have landed while this was
          // in flight. It is newer by definition, so it must not be
          // overwritten by this answer.
          if (
            generation === (this._providerChainGenerations.get(provider) ?? 0) &&
            typeof result === "string"
          ) {
            this.rememberProviderChain(provider, parseChainId(result));
          }
          return result as T;
        });
      }

      // Handle Signatures
      if (
        Array.isArray(params) &&
        ["eth_signTypedData_v4", "personal_sign"].includes(method)
      ) {
        if (!this.isAutocaptureEnabled("signature")) {
          logger.debug(`Signature event skipped (autocapture.signature: false)`, { method });
          return request({ method, params });
        }
        // Issue the wallet call FIRST, before the chain lookup is even
        // started. Not awaiting our own lookup is not enough: a provider that
        // serializes RPC over a single transport - WalletConnect's relay
        // socket above all, which is exactly the transport this path exists to
        // support - would queue the signing request behind an `eth_chainId`
        // that is already in flight, so a stalled lookup would hold the wallet
        // prompt closed anyway. The SDK-side timeout cannot help there: it
        // releases our promise, not the provider's queue.
        const responsePromise = request({ method, params }) as Promise<T>;
        // Attach a no-op handler now so a rejection arriving before the await
        // below is never reported as unhandled. The real handling is there.
        responsePromise.catch(() => undefined);

        // One synchronous snapshot for the whole lifecycle of this call, taken
        // before the wallet can change anything. No RPC: see
        // resolveChainIdForProvider.
        const capturedChainId = this.resolveChainIdForProvider(provider);
        // Fire-and-forget tracking
        (async () => {
          try {
            await this.signature({
              status: SignatureStatus.REQUESTED,
              ...this.buildSignatureEventPayload(
                method,
                params,
                undefined,
                capturedChainId,
                provider
              ),
            });
          } catch (e) {
            logger.error("Formo: Failed to track signature request", e);
          }
        })();

        try {
          const response = await responsePromise;
          // Track signature confirmation only for truthy responses
          if (response) {
            (async () => {
              try {
                    await this.signature({
                  status: SignatureStatus.CONFIRMED,
                  ...this.buildSignatureEventPayload(
                    method,
                    params,
                    response,
                    capturedChainId,
                    provider
                  ),
                });
              } catch (e) {
                logger.error(
                  "Formo: Failed to track signature confirmation",
                  e
                );
              }
            })();
          }
          return response;
        } catch (error) {
          const rpcError = error as RPCError;
          if (rpcError?.code === 4001) {
            // Use the already cast rpcError to avoid duplication
            (async () => {
              try {
                await this.signature({
                  status: SignatureStatus.REJECTED,
                  ...this.buildSignatureEventPayload(
                    method,
                    params,
                    undefined,
                    capturedChainId,
                    provider
                  ),
                });
              } catch (e) {
                logger.error("Formo: Failed to track signature rejection", e);
              }
            })();
          }
          throw error;
        }
      }

      // Handle Transactions
      // TODO: Support eip5792.xyz calls
      if (
        Array.isArray(params) &&
        method === "eth_sendTransaction" &&
        params[0]
      ) {
        if (!this.isAutocaptureEnabled("transaction")) {
          logger.debug(`Transaction event skipped (autocapture.transaction: false)`, { method });
          return request({ method, params });
        }
        // Issue the wallet call FIRST, for the same reason as the signature
        // path above: a provider that serializes RPC would otherwise queue the
        // transaction behind our `eth_chainId`.
        const txPromise = request({ method, params }) as Promise<string>;
        txPromise.catch(() => undefined);

        // One snapshot for the whole lifecycle of this call. Resolving per
        // status would let a network switch made while the prompt is open
        // split STARTED and BROADCASTED across different chains.
        const txChainId = this.resolveChainIdForProvider(provider);

        (async () => {
          try {
            const payload = await this.buildTransactionEventPayload(
              params,
              provider,
              txChainId
            );
            await this.transaction({ status: TransactionStatus.STARTED, ...payload });
          } catch (e) {
            logger.error("Formo: Failed to track transaction start", e);
          }
        })();

        try {
          const transactionHash = await txPromise;

          (async () => {
            try {
              const payload = await this.buildTransactionEventPayload(
                params,
                provider,
                txChainId
              );
              await this.transaction({
                status: TransactionStatus.BROADCASTED,
                ...payload,
                transactionHash,
              });

              // Start async polling for transaction receipt
              this.pollTransactionReceipt(provider, transactionHash, payload);
            } catch (e) {
              logger.error("Formo: Failed to track transaction broadcast", e);
            }
          })();

          return transactionHash as unknown as T;
        } catch (error) {
          const rpcError = error as RPCError;
          if (rpcError?.code === 4001) {
            // Use the already cast rpcError to avoid duplication
            (async () => {
              try {
                const payload = await this.buildTransactionEventPayload(
                  params,
                  provider,
                  txChainId
                );
                await this.transaction({
                  status: TransactionStatus.REJECTED,
                  ...payload,
                });
              } catch (e) {
                logger.error("Formo: Failed to track transaction rejection", e);
              }
            })();
          }
          throw error;
        }
      }

      return request({ method, params });
    };
    // Mark the wrapper so we can detect if request is replaced externally and keep a reference on provider
    wrappedRequest[WRAPPED_REQUEST_SYMBOL] = true;
    (provider as WrappedEIP1193Provider)[WRAPPED_REQUEST_REF_SYMBOL] =
      wrappedRequest;

    try {
      // Attempt to assign the wrapped request function (rely on try-catch for mutability errors)
      provider.request = wrappedRequest;
    } catch (e) {
      logger.warn("Failed to wrap provider.request; skipping", e);
    }
  }

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

  /** @see TrackingPolicy.isChainExcluded */
  private isCurrentChainExcluded(eventChainId?: ChainID): boolean {
    return this.trackingPolicy.isChainExcluded({ chainId: eventChainId });
  }

  /** @see TrackingPolicy.isPageExcluded */
  private isPageExcluded(): boolean {
    return this.trackingPolicy.isPageExcluded();
  }

  /** @see TrackingPolicy.isPersistedIdentityPurgeRequired */
  private isPersistedIdentityPurgeRequired(): boolean {
    return this.trackingPolicy.isPersistedIdentityPurgeRequired();
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

  /**
   * Get provider information for a given provider
   * @param provider The provider to get info for
   * @returns Provider information
   */
  private getProviderInfo(provider: EIP1193Provider): {
    name: string;
    rdns: string;
  } {
    // First check if provider is in our EIP-6963 providers list
    const eip6963Provider = this._providers.find(
      (p) => p.provider === provider
    );
    if (eip6963Provider) {
      return {
        name: eip6963Provider.info.name,
        rdns: eip6963Provider.info.rdns,
      };
    }

    // Fallback to injected provider detection
    const injectedInfo = detectInjectedProviderInfo(provider);
    return {
      name: injectedInfo.name,
      rdns: injectedInfo.rdns,
    };
  }

  private async getProviders(): Promise<readonly EIP6963ProviderDetail[]> {
    const store = createStore();
    let providers = store.getProviders();

    store.subscribe((providerDetails) => {
      providers = providerDetails;

      // Process newly added providers with proper deduplication
      const newlyAddedDetails = providerDetails.filter((detail) => {
        const provider = detail?.provider as EIP1193Provider | undefined;
        return provider && !this._seenProviders.has(provider);
      });

      // Add new providers to the array without overwriting existing ones
      for (const detail of newlyAddedDetails) {
        this.safeAddProviderDetail(detail);
      }

      // Track listeners for newly discovered providers only
      const newDetails = providerDetails.filter((detail) => {
        const p = detail?.provider as EIP1193Provider | undefined;
        return !!p && !this._trackedProviders.has(p);
      });

      if (newDetails.length > 0) {
        this.trackProviders(newDetails);
        // Detect newly discovered wallets (session de-dupes) with error handling
        (async () => {
          try {
            await this.detectWallets(newDetails);
          } catch (e) {
            logger.error("Formo: Failed to detect wallets", e);
          }
        })();
      }

      // Clean up providers that are no longer available
      this.cleanupUnavailableProviders();
    });

    // Fallback to injected provider if no providers are found
    if (providers.length === 0) {
      const injected =
        typeof window !== "undefined" ? window.ethereum : undefined;
      if (injected) {
        // If we have already detected and cached the injected provider, and it's the same instance, return the cached result
        if (
          this._injectedProviderDetail &&
          this._injectedProviderDetail.provider === injected
        ) {
          // Ensure it's tracked
          if (!this._trackedProviders.has(injected)) {
            this.trackEIP1193Provider(injected);
          }
          // Merge with existing providers instead of overwriting
          if (
            !this._providers.some((existing) => existing.provider === injected)
          ) {
            this._providers = [
              ...this._providers,
              this._injectedProviderDetail,
            ];
          }
          return this._providers;
        }

        // Re-check if the injected provider is already tracked just before tracking
        if (!this._trackedProviders.has(injected)) {
          this.trackEIP1193Provider(injected);
        }

        // Create a mock EIP6963ProviderDetail for the injected provider
        const injectedProviderInfo = detectInjectedProviderInfo(injected);
        const injectedDetail: EIP6963ProviderDetail = {
          provider: injected,
          info: injectedProviderInfo,
        };

        // Cache the detected injected provider detail
        this._injectedProviderDetail = injectedDetail;

        // Merge with existing providers instead of overwriting
        this.safeAddProviderDetail(injectedDetail);
      }
      return this._providers;
    }

    // Initialize providers array with discovered providers, avoiding duplicates
    const uniqueProviders = providers.filter(
      (detail: EIP6963ProviderDetail) => {
        const provider = detail?.provider as EIP1193Provider | undefined;
        return provider && !this._seenProviders.has(provider);
      }
    );

    // Add to seen providers and instances, ensuring no duplicates in _providers
    for (const detail of uniqueProviders) {
      this.safeAddProviderDetail(detail);
    }

    return this._providers;
  }

  get providers(): readonly EIP6963ProviderDetail[] {
    return this._providers;
  }

  private async detectWallets(
    providers: readonly EIP6963ProviderDetail[]
  ): Promise<void> {
    try {
      for (const eip6963ProviderDetail of providers) {
        await this.detect({
          providerName: eip6963ProviderDetail?.info.name,
          rdns: eip6963ProviderDetail?.info.rdns,
        });
      }
    } catch (err) {
      logger.error("Error detect all wallets:", err);
    }
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

  private async getAddress(
    provider?: EIP1193Provider
  ): Promise<Address | null> {
    // Use EVM-specific state to avoid returning a Solana address in an EVM context
    if (this._chainState.evm.address) return this._chainState.evm.address;
    const p = provider || this.provider;
    if (!p) {
      logger.info("The provider is not set");
      return null;
    }

    try {
      const accounts = await this.getAccounts(p);
      if (accounts && accounts.length > 0) {
        return validateAndChecksumAddress(accounts[0]) || null;
      }
    } catch (err) {
      const code = (err as RPCError)?.code;
      if (code !== 4001) {
        logger.error(
          "FormoAnalytics::getAccounts: eth_accounts threw an error",
          err
        );
      }
      return null;
    }
    return null;
  }

  private async getAccounts(
    provider?: EIP1193Provider
  ): Promise<Address[] | null> {
    const p = provider || this.provider;
    try {
      const res: string[] | null | undefined = await p?.request({
        method: "eth_accounts",
      });
      if (!res || res.length === 0) return null;
      return res
        .map((e) => validateAndChecksumAddress(e))
        .filter((e): e is Address => e !== undefined);
    } catch (err) {
      const code = (err as RPCError)?.code;
      if (code !== 4001) {
        logger.error(
          "FormoAnalytics::getAccounts: eth_accounts threw an error",
          err
        );
      }
      return null;
    }
  }

  /**
   * Resolve the chain an autocaptured request actually ran on.
   *
   * `_evmChainId` is maintained by `chainChanged` from whichever provider is
   * currently active. When a request arrives from a *different* tracked
   * provider - which happens whenever a visitor has two wallets installed -
   * that cached value describes the wrong wallet, and tagging the event with
   * it silently mis-attributes the chain.
   *
   * Answered entirely from a per-provider snapshot. This is deliberately
   * SYNCHRONOUS and never issues an RPC.
   *
   * An earlier version called `eth_chainId` on the signing provider and
   * time-boxed it with `Promise.race`. That is not safe: the race abandons the
   * SDK's promise but cannot cancel the provider's request. On a transport
   * that serializes - WalletConnect's relay socket, the very case this path
   * exists to serve - an abandoned lookup stays at the head of the wallet's
   * queue, and every later RPC the dapp makes queues behind it until reload.
   * Mislabelling a chain is a reporting defect; wedging the user's wallet is
   * not acceptable to avoid one.
   *
   * When nothing is known, this reports 0 ("unknown") rather than guessing
   * with the active provider's chain, which is known-wrong for another wallet.
   */
  private resolveChainIdForProvider(provider?: EIP1193Provider): number {
    if (provider) {
      const known = this._providerChainIds.get(provider);
      if (known) return known;
      // Only the active provider's chain is described by the central cache.
      if (provider === this._provider && this._evmChainId) {
        return this._evmChainId;
      }
      // A tracked provider we have never heard a chain from. Deliberately no
      // fall back to `_evmChainId`: it belongs to a different wallet.
      return 0;
    }

    return this._evmChainId || 0;
  }

  /**
   * Record a provider's chain. Fed by `chainChanged` and `connect`, and by the
   * one-off probe at tracking time - never from inside a user request.
   */
  private rememberProviderChain(
    provider: EIP1193Provider | undefined,
    chainId: number | undefined
  ): void {
    if (!provider || !chainId) return;
    // Any observation is newer than an `eth_chainId` still in flight for this
    // provider.
    this.bumpProviderChainGeneration(provider);
    this._providerChainIds.set(provider, chainId);

    // If this IS the active provider, central state has to follow. Recording
    // it only per provider left `currentChainId` on a chain restored from a
    // previous session, and the unscoped events that fall back to it were sent
    // despite an exclusion covering the chain the wallet was really on.
    //
    // Guarded on EVM already being the active namespace. `setChainState()`
    // makes whichever namespace it touches active, so syncing here
    // unconditionally let a background EVM wallet's chain report steal the
    // active slot from a live Solana wallet, and every later page or track
    // event was attributed to the wrong wallet entirely.
    if (
      provider === this._provider &&
      this._activeNamespace === "evm" &&
      this._evmChainId !== chainId
    ) {
      this.setChainState('evm', { chainId });
    }
  }

  /** Advance and return this provider's chain-observation generation. */
  private bumpProviderChainGeneration(provider: EIP1193Provider): number {
    const next = (this._providerChainGenerations.get(provider) ?? 0) + 1;
    this._providerChainGenerations.set(provider, next);
    return next;
  }

  /**
   * Seed a provider's chain from whatever it already exposes synchronously.
   *
   * Most EIP-1193 implementations carry a `chainId` property (MetaMask,
   * WalletConnect, Coinbase). Reading it costs nothing and cannot block.
   *
   * There is deliberately no RPC fallback. An earlier version probed with
   * `eth_chainId` when a provider was first tracked, on the theory that
   * tracking time is off the user's critical path. It is not: a serialized
   * transport has ONE queue, so a stalled probe sits in front of every later
   * signature and transaction the dapp makes. It could also land out of order
   * - a slow probe response overwriting a newer `chainChanged` - and relabel
   * events onto a chain the wallet had already left.
   *
   * A provider that exposes nothing stays unknown until it emits
   * `chainChanged` or `connect`, and unknown is reported honestly as 0.
   */
  private seedProviderChainFromState(provider: EIP1193Provider): void {
    const raw = (provider as unknown as { chainId?: unknown }).chainId;
    const chainId =
      typeof raw === "string"
        ? parseChainId(raw)
        : typeof raw === "number"
          ? raw
          : undefined;
    this.rememberProviderChain(provider, chainId);
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

  private buildSignatureEventPayload(
    method: string,
    params: unknown[],
    // Intentionally not read. Kept for positional call-site arity.
    _response?: unknown,
    chainId?: number,
    provider?: EIP1193Provider
  ) {
    const rawAddress =
      method === "personal_sign"
        ? (params[1] as Address)
        : (params[0] as Address);

    const validAddress = validateAndChecksumAddress(rawAddress);
    if (!validAddress) {
      throw new Error(`Invalid address in signature payload: ${rawAddress}`);
    }

    const effectiveChainId = chainId ?? this._evmChainId ?? undefined;
    // Only the active provider may write central wallet state - see the same
    // guard in buildTransactionEventPayload.
    if (!provider || provider === this._provider || !this._provider) {
      this.backfillActiveWallet(validAddress, effectiveChainId, provider);
    }

    const basePayload = {
      chainId: effectiveChainId,
      address: validAddress,
    };

    if (method === "personal_sign") {
      const message = Buffer.from(
        (params[0] as string).slice(2),
        "hex"
      ).toString("utf8");
      return {
        ...basePayload,
        message,
      };
    }

    // eth_signTypedData*: params[1] is the full EIP-712 struct.
    return {
      ...basePayload,
      message: params[1] as string,
    };
  }

  private async buildTransactionEventPayload(
    params: unknown[],
    provider?: EIP1193Provider,
    /**
     * Chain resolved once for this request's whole lifecycle. Passing it keeps
     * every status of one transaction on the same chain even if the user
     * switches network while the wallet prompt is open.
     */
    capturedChainId?: number
  ) {
    const { data, from, to, value } = params[0] as {
      data: string;
      from: string;
      to: string;
      value: string;
    };

    const validAddress = validateAndChecksumAddress(from);
    if (!validAddress) {
      throw new Error(`Invalid address in transaction payload: ${from}`);
    }

    const chainId =
      capturedChainId ?? this.resolveChainIdForProvider(provider);
    // Only the ACTIVE provider may write central wallet state. A request from
    // a second, non-active wallet would otherwise overwrite the active
    // provider's address and chain, and every later request through the active
    // provider would then trust the other wallet's chain - persistent
    // mis-attribution, and a way around `excludeChains`.
    if (!provider || provider === this._provider || !this._provider) {
      this.backfillActiveWallet(validAddress, chainId, provider);
    }

    return {
      chainId,
      data,
      address: validAddress,
      to,
      value,
    };
  }

  /**
   * Persist an EVM address discovered through autocapture (signature / transaction)
   * as the current EVM address when none is currently set. This lets subsequent
   * track()/page() calls carry the address even when the underlying wallet never
   * fires an EIP-1193 `accountsChanged` event (embedded wallets, smart accounts,
   * social-login wrappers). If `accountsChanged` later fires it overwrites this
   * value in the normal way; existing connections are never clobbered.
   */
  private backfillActiveWallet(
    address: Address,
    chainId?: ChainID,
    provider?: EIP1193Provider
  ): void {
    // Refuse a chain the provider has since moved off.
    //
    // A request captures its chain once and reuses that snapshot for every
    // status it emits, which is right for the event payload - a confirmation
    // must not be relabelled mid-flight. But writing that captured value back
    // into central state on the LATER statuses restored a chain the wallet had
    // already left, and the unscoped events that fall back to it then bypassed
    // an exclusion that should have caught them.
    if (provider && chainId !== undefined && chainId !== 0) {
      const current = this._providerChainIds.get(provider);
      if (current !== undefined && current !== chainId) {
        chainId = current;
      }
    }
    // `0` is kept deliberately. It means "could not resolve", and persisting
    // it is what lets the exclusion gate refuse the unscoped events - `page`,
    // `track`, `identify` - that carry no chain of their own and fall back to
    // `currentChainId`. Erasing it to `undefined` looked tidier but removed
    // the only marker distinguishing "unknown" from "no wallet yet", and those
    // events then went out attributed to a wallet that might be sitting on an
    // excluded chain.
    // Never learn identity while suppressed (opt-out / timezone / excluded host
    // or path). A signature/transaction observed on an excluded route must not
    // populate currentAddress for later allowed-page events.
    if (this.isTrackingSuppressed()) return;

    const known = this._evmAddress;
    if (known) {
      // Same wallet, newer chain: correct it rather than returning.
      //
      // A persisted wallet restores a chain from a previous session. If the
      // provider has since moved - to an excluded chain, or to one we cannot
      // resolve - the autocaptured event is gated correctly, but the stale
      // restored chain stayed in `currentChainId` and the unscoped events
      // that fall back to it went out under an exclusion that should have
      // caught them.
      if (
        chainId !== undefined &&
        known.toLowerCase() === address.toLowerCase() &&
        this._evmChainId !== chainId
      ) {
        this.setChainState('evm', { address: known, chainId });
      }
      // A DIFFERENT address is another wallet's business; never overwrite.
      return;
    }

    this.setChainState('evm', { address, chainId });
  }

  /**
   * Apply an EVM autocapture connect/switch while tracking is suppressed
   * (opt-out / timezone / excluded host or path): never LEARN the wallet, but
   * if it is a switch away from an already-learned EVM wallet, drop the stale
   * one (which also clears the active-wallet cookie) so it can't attach to a
   * later allowed-page event.
   */
  private clearStaleEvmWalletOnSwitchWhileSuppressed(address: string): void {
    const evmAddress = this._chainState.evm.address;
    const incoming = validateAndChecksumAddress(address);
    if (evmAddress && incoming && incoming !== evmAddress) {
      this.clearChainState('evm');
    }
  }

  /**
   * Polls for transaction receipt and emits tx.status = CONFIRMED or REVERTED.
   */
  private async pollTransactionReceipt(
    provider: EIP1193Provider,
    transactionHash: string,
    payload: any,
    maxAttempts = 10,
    intervalMs = 3000
  ) {
    let attempts = 0;
    if (!provider) return;
    type Receipt = { status: string | number } | null;
    const poll = async () => {
      try {
        const receipt = (await provider.request({
          method: "eth_getTransactionReceipt",
          params: [transactionHash],
        })) as Receipt;
        if (receipt) {
          // status: 1 = success, 0 = reverted
          if (receipt.status === "0x1" || receipt.status === 1) {
            this.transaction({
              status: TransactionStatus.CONFIRMED,
              ...payload,
              transactionHash,
            });
            return;
          } else if (receipt.status === "0x0" || receipt.status === 0) {
            this.transaction({
              status: TransactionStatus.REVERTED,
              ...payload,
              transactionHash,
            });
            return;
          }
        }
      } catch (e) {
        logger.error("Error polling transaction receipt", e);
      }
      attempts++;
      if (attempts < maxAttempts) {
        setTimeout(poll, intervalMs);
      }
    };
    poll();
  }

  private removeProviderListeners(provider: EIP1193Provider): void {
    const listeners = this._providerListenersMap.get(provider);
    if (!listeners) return;
    for (const [event, fn] of Object.entries(listeners)) {
      try {
        provider.removeListener(event, fn);
      } catch (e) {
        logger.warn(`Failed to remove listener for ${String(event)}`, e);
      }
    }
    this._providerListenersMap.delete(provider);
  }

  // Explicitly untrack a provider: remove listeners, clear wrapper flag
  // and tracking
  private untrackProvider(provider: EIP1193Provider): void {
    try {
      this.removeProviderListeners(provider);
      this._trackedProviders.delete(provider);

      if (this._provider === provider) {
        this.clearActiveProvider();
      }
    } catch (e) {
      logger.warn("Failed to untrack provider", e);
    }
  }

  // Debug/monitoring helpers
  public getTrackedProvidersCount(): number {
    return this._trackedProviders.size;
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
    return {
      totalProviders: this._providers.length,
      trackedProviders: this._trackedProviders.size,
      seenProviders: this._seenProviders.size,
      activeProvider: !!this._provider,
    };
  }

  /**
   * Clean up providers that are no longer available
   * This helps maintain consistent state and prevents memory leaks
   */
  private cleanupUnavailableProviders(): void {
    // Remove providers that are no longer in the current providers list
    const currentProviderInstances = new Set(
      this._providers.map((detail) => detail.provider as EIP1193Provider)
    );

    for (const provider of Array.from(this._trackedProviders)) {
      if (!currentProviderInstances.has(provider)) {
        logger.info(
          `Cleaning up unavailable provider: ${provider.constructor.name}`
        );
        this.untrackProvider(provider);
      }
    }
  }

  /**
   * Helper method to check if a provider is already wrapped
   * @param provider The provider to check
   * @param currentRequest The current request function
   * @returns true if the provider is already wrapped
   */
  private isProviderAlreadyWrapped(
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

  /**
   * Handle provider mismatch by switching to the new provider and invalidating old tokens
   * @param provider The new provider to switch to
   */
  private handleProviderMismatch(provider: EIP1193Provider): void {
    // If this is a different provider, allow the switch
    if (this._provider) {
      // Clear any provider-specific state when switching
      this.setChainState('evm', { address: undefined, chainId: undefined, provider });
    } else {
      this._provider = provider;
    }
  }

  /**
   * Determine which namespace a chainId belongs to.
   */
  private getNamespace(chainId?: ChainID): ChainNamespace {
    return isSolanaChainId(chainId) ? 'solana' : 'evm';
  }

  /**
   * Update per-chain state and sync the derived currentAddress/currentChainId.
   * Accepts either a namespace string ('evm'/'solana') or a chainId number
   * to resolve the namespace automatically. When a chainId number is passed,
   * it is also stored as the namespace's chainId (unless explicitly overridden
   * in the update object).
   */
  private setChainState(
    namespaceOrChainId: ChainNamespace | ChainID | undefined,
    update: { address?: Address; chainId?: ChainID; provider?: EIP1193Provider }
  ): void {
    const namespace = typeof namespaceOrChainId === 'string'
      ? namespaceOrChainId
      : this.getNamespace(namespaceOrChainId);
    const ns = this._chainState[namespace];
    if ('address' in update) {
      // A namespace changing hands is what the generation tracks. Doing it
      // here rather than at each caller means every claiming path is
      // covered: connect(), the public syncWalletState() an integration
      // calls, and the EIP-1193 listeners alike.
      //
      // Only a CHANGE counts. Re-writing the same wallet (a chain switch,
      // a re-confirmation) must not bump, or a legitimate disconnect that
      // raced one would decide it was stale and leave the state behind.
      const claimed =
        !!update.address &&
        update.address.toLowerCase() !== (ns.address ?? "").toLowerCase();
      if (claimed) this._sessionSeq[namespace]++;
      ns.address = update.address;
    }
    if ('chainId' in update) {
      ns.chainId = update.chainId;
    } else if (typeof namespaceOrChainId === 'number') {
      ns.chainId = namespaceOrChainId;
    }
    if (namespace === 'evm' && 'provider' in update) {
      // Displacing the active provider ends its connection as far as this SDK
      // is concerned, so the connect it reported stops counting.
      this.forgetConnectRecord(
        (ns as EvmChainState).provider,
        update.provider
      );
      (ns as EvmChainState).provider = update.provider;
    }
    this._activeNamespace = namespace;
    this.syncDerivedState();
  }

  /**
   * Clear per-chain state for a given namespace (or chainId) and sync derived state.
   */
  private clearChainState(namespaceOrChainId: ChainNamespace | ChainID | undefined): void {
    const namespace = typeof namespaceOrChainId === 'string'
      ? namespaceOrChainId
      : this.getNamespace(namespaceOrChainId);
    if (namespace === 'evm') {
      // Same rule: wiping the namespace drops the active provider.
      this.forgetConnectRecord(this._chainState.evm.provider, undefined);
      this._chainState.evm = {};
    } else {
      this._chainState.solana = {};
    }
    this.syncDerivedState();
  }

  /**
   * Sync validated wallet/chain state into the SDK's central state
   * WITHOUT emitting an event.
   *
   * Integrations (e.g. the wagmi handler) must call this on every
   * connect / chain-change / disconnect - even when the corresponding
   * autocapture event is disabled. Otherwise `currentChainId` stays
   * stale/undefined and `shouldTrack()`'s `tracking.excludeChains`
   * check (which keys off `currentChainId`, not the event payload) can
   * be bypassed, letting wallet activity on an excluded chain still be
   * collected.
   *
   * - valid `address` present → record per-chain + derived state
   * - `address` absent → clear chain state (disconnect)
   */
  public syncWalletState(params: {
    chainId?: ChainID;
    address?: Address;
  }): void {
    const { chainId, address } = params;

    if (this.isTrackingSuppressed()) {
      // While suppressed (opt-out / timezone / excluded host or path) we must
      // never LEARN a new wallet - but we must still CLEAR stale identity.
      // Otherwise a disconnect or wallet switch observed on a suppressed route
      // would leave the previously-learned address in memory and in the
      // active-wallet cookie, attaching it to later allowed-page events.
      if (!address) {
        // Disconnect: drop the affected namespace(s).
        if (chainId !== undefined && chainId !== null) {
          this.clearChainState(chainId);
        } else {
          this.clearChainState("evm");
          this.clearChainState("solana");
        }
        return;
      }
      // Address present: a switch away from the wallet already learned in this
      // namespace invalidates it. Drop the stale one without learning the new
      // address; a fresh connect (nothing learned yet) or a re-confirmation of
      // the same address is a no-op.
      if (chainId === null || chainId === undefined) return;
      const namespace = this.getNamespace(chainId);
      const namespaceAddress = this._chainState[namespace].address;
      const validIncoming = validateAddress(address, chainId);
      if (
        namespaceAddress &&
        validIncoming &&
        validIncoming !== namespaceAddress
      ) {
        this.clearChainState(chainId);
      }
      return;
    }

    if (!address) {
      if (chainId !== undefined && chainId !== null) {
        this.clearChainState(chainId);
      } else {
        this.clearChainState("evm");
        this.clearChainState("solana");
      }
      return;
    }

    if (chainId === null || chainId === undefined) return;

    const validAddress = validateAddress(address, chainId);
    if (!validAddress) {
      logger.warn(
        `syncWalletState: invalid address ("${address}") for chain ${chainId}`
      );
      return;
    }

    this.setChainState(chainId, { address: validAddress });
  }

  /**
   * Synchronize currentAddress/currentChainId from the active namespace.
   * Last-connected-chain-wins: _activeNamespace takes precedence.
   */
  private syncDerivedState(): void {
    const active = this._activeNamespace;
    if (active) {
      const state = this._chainState[active];
      if (state.address || state.chainId) {
        this.currentAddress = state.address;
        this.currentChainId = state.chainId;
        this.persistActiveWallet();
        return;
      }
    }
    // Fall through to the other namespace
    const other: ChainNamespace = active === 'evm' ? 'solana' : 'evm';
    const otherState = this._chainState[other];
    if (otherState.address || otherState.chainId) {
      this.currentAddress = otherState.address;
      this.currentChainId = otherState.chainId;
      this._activeNamespace = other;
      this.persistActiveWallet();
      return;
    }
    this.currentAddress = undefined;
    this.currentChainId = undefined;
    this.persistActiveWallet();
  }

  /**
   * Persist (or clear) the current wallet snapshot in a cookie so that the
   * SDK can repopulate `currentAddress`/`currentChainId` at init on the next
   * page load - closing the gap between page-show and wagmi/EIP-1193
   * reconnection during which track()/page() events would otherwise ship
   * with an empty address.
   */
  private persistActiveWallet(): void {
    try {
      // Visitor-level suppression (opt-out or excluded timezone): purge any
      // prior snapshot - these are stable for the session, so deletion is safe.
      if (this.isPersistedIdentityPurgeRequired()) {
        cookie().remove(ACTIVE_WALLET_KEY);
        return;
      }
      if (this.currentAddress) {
        // Current-page exclusion (host/path): do not write a new snapshot while
        // on an excluded route, but leave any existing cookie intact. A cookie
        // written on an allowed page must survive a transient visit to an
        // excluded one (passive navigation does not call this method).
        if (this.isPageExcluded()) {
          return;
        }
        const value = JSON.stringify({
          address: this.currentAddress,
          ...(this.currentChainId !== undefined && { chainId: this.currentChainId }),
        });
        const domain = getIdentityCookieDomain(this.crossSubdomainCookies);
        cookie().set(ACTIVE_WALLET_KEY, value, {
          path: "/",
          expires: new Date(Date.now() + ACTIVE_WALLET_TTL_MS).toUTCString(),
          ...getIdentityCookieSecurity(),
          ...(domain ? { domain } : {}),
        });
      } else {
        // No active wallet → clear the snapshot. This runs even on an excluded
        // route, so a disconnect/switch observed while suppressed actively
        // removes stale identity instead of leaving it for later allowed events.
        cookie().remove(ACTIVE_WALLET_KEY);
      }
    } catch (err) {
      logger.warn("Failed to persist current wallet snapshot", err);
    }
  }

  /**
   * Seed `currentAddress`/`currentChainId` from the persisted snapshot, if
   * any. Called once during construction before the first page hit fires.
   */
  private loadActiveWallet(): void {
    try {
      // Visitor-level suppression (opt-out or excluded timezone): never restore
      // identity into memory; drop the stale snapshot.
      if (this.isPersistedIdentityPurgeRequired()) {
        cookie().remove(ACTIVE_WALLET_KEY);
        return;
      }
      // Current-page exclusion (host/path): don't restore into memory while on
      // an excluded route, but keep the cookie so a later allowed-page load can
      // restore it.
      if (this.isPageExcluded()) {
        return;
      }
      const raw = cookie().get(ACTIVE_WALLET_KEY) as string | undefined;
      if (!raw) return;
      const parsed = JSON.parse(raw) as { address?: string; chainId?: ChainID };
      if (!parsed?.address) return;

      const namespace = isSolanaChainId(parsed.chainId) ? "solana" : "evm";
      const validated = validateAddress(parsed.address, parsed.chainId);
      if (!validated) {
        cookie().remove(ACTIVE_WALLET_KEY);
        return;
      }
      const ns = this._chainState[namespace];
      ns.address = validated;
      if (parsed.chainId !== undefined) ns.chainId = parsed.chainId;
      this._activeNamespace = namespace;
      this.currentAddress = validated;
      this.currentChainId = parsed.chainId;
    } catch (err) {
      logger.warn("Failed to restore persisted wallet snapshot", err);
      cookie().remove(ACTIVE_WALLET_KEY);
    }
  }

  /**
   * Helper method to clear the active provider state
   * Centralizes provider clearing logic for consistency
   */
  private clearActiveProvider(): void {
    this._provider = undefined;
  }

  /**
   * Record that this provider's connection is being torn down.
   *
   * Must run at EVERY teardown site, before anything is awaited, and whether
   * or not a disconnect event will be emitted. A connect observation that
   * began earlier must not claim the namespace afterwards, and whether the
   * app opted into disconnect autocapture has no bearing on that ordering.
   */
  private beginProviderDisconnect(provider: EIP1193Provider): void {
    this._disconnectEpoch.set(
      provider,
      (this._disconnectEpoch.get(provider) ?? 0) + 1
    );
  }

  /**
   * True when a newer session claimed the EVM namespace since `seq` was
   * taken, so whatever transition took it is stale and must be abandoned.
   */
  private isStaleEvmTransition(seq: number): boolean {
    if (this._sessionSeq.evm === seq) return false;
    logger.info(
      "OnAccountsChanged: A newer session claimed the wallet slot while this switch was in flight; abandoning it"
    );
    return true;
  }

  /**
   * Helper method to safely add a provider detail to _providers array, ensuring no duplicates
   * @param detail The provider detail to add
   * @returns true if the provider was added, false if it was already present
   */
  private safeAddProviderDetail(detail: EIP6963ProviderDetail): boolean {
    const provider = detail?.provider as EIP1193Provider | undefined;
    if (!provider) return false;

    // Check if provider already exists in _providers array
    const alreadyExists = this._providers.some(
      (existing) => existing.provider === provider
    );

    if (!alreadyExists) {
      // Add to providers array and mark as seen
      this._providers = [...this._providers, detail];
      this._seenProviders.add(provider);
      return true;
    } else {
      // Ensure provider is marked as seen even if it already exists in _providers
      this._seenProviders.add(provider);
      return false;
    }
  }
}
