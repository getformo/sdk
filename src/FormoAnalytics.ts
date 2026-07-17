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
  TrackingOptions,
  TransactionStatus,
  ConnectInfo,
  WrappedEIP1193Provider,
  WrappedRequestFunction,
  WRAPPED_REQUEST_SYMBOL,
  WRAPPED_REQUEST_REF_SYMBOL,
} from "./types";
import { validateAddress, validateAndChecksumAddress } from "./utils/address";
import { getTimezone } from "./utils/timezone";
import { isLocalhost } from "./validators";
import { parseChainId } from "./utils/chain";
import { WagmiEventHandler } from "./wagmi";
import { isSolanaChainId } from "./solana";
import { SolanaManager } from "./solana/SolanaManager";
import { identifyPrivyUser } from "./privy";
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
  // Per-chain namespace state — isolates EVM and Solana connection state
  private _chainState: { evm: EvmChainState; solana: ChainState } = {
    evm: {},
    solana: {},
  };
  private _activeNamespace?: ChainNamespace;

  // EVM state accessors — EVM listener paths must use these instead of
  // currentAddress/currentChainId to avoid cross-namespace reads.
  private get _provider(): EIP1193Provider | undefined {
    return this._chainState.evm.provider;
  }
  private set _provider(value: EIP1193Provider | undefined) {
    this._chainState.evm.provider = value;
  }
  private get _evmAddress(): Address | undefined {
    return this._chainState.evm.address;
  }
  private get _evmChainId(): ChainID | undefined {
    return this._chainState.evm.chainId;
  }

  private _providerListenersMap: Map<
    EIP1193Provider,
    Record<string, (...args: unknown[]) => void>
  > = new Map();
  private session: FormoAnalyticsSession;
  private eventManager: IEventManager;
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
    this.isAutocaptureEnabled = this.isAutocaptureEnabled.bind(this);

    // Initialize logger with configuration from options
    Logger.init({
      enabled: options.logger?.enabled || false,
      enabledLevels: options.logger?.levels || [],
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

    // Drop buffered events so a torn-down instance can't flush later.
    this.eventManager.clear();

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
    // currentAddress/currentChainId) before trackEvent's consent check —
    // gate the whole method so a suppressed visitor or excluded environment
    // (opt-out / timezone / host / path) leaves no session state.
    if (this.isTrackingSuppressed()) {
      logger.info("connect() skipped: tracking is suppressed for this visitor or environment");
      return;
    }

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
   * // Privy: pass the usePrivy() user with `{ privy: true }` to identify every
   * // linked wallet under the user's DID in one call. Attribution defaults to
   * // Privy's primary wallet (user.wallet); pass `activeAddress` to override.
   * const { user } = usePrivy();
   * if (user) formo.identify(user, { privy: true });
   * ```
   */
  async identify(
    user: PrivyUser,
    options: {
      privy: true;
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
      | { privy: true; activeAddress?: string; properties?: IFormoEventProperties },
    context?: IFormoEventContext,
    callback?: (...args: unknown[]) => void
  ): Promise<void> {
    try {
      // Privy convenience form: identify(user, { privy: true, activeAddress? }).
      // Delegate to the Privy adapter, which expands the user's linked wallets
      // into one identify per wallet under the shared DID. Kept as a thin
      // dispatch so the Privy-specific logic stays in the privy module.
      //
      // The `{ privy: true }` flag alone is not enough to switch forms:
      // `IFormoEventProperties` is an open record, so a normal identify could
      // legitimately carry a property named `privy`. Only take the Privy branch
      // when the first argument is actually Privy-user-shaped (a string `id`,
      // and not an address-keyed identify params object).
      const maybeUser = paramsOrUser as
        | (Partial<PrivyUser> & { address?: unknown })
        | undefined;
      if (
        propertiesOrOptions &&
        (propertiesOrOptions as { privy?: unknown }).privy === true &&
        maybeUser &&
        typeof maybeUser.id === "string" &&
        maybeUser.address === undefined
      ) {
        const opts = propertiesOrOptions as {
          activeAddress?: string;
          properties?: IFormoEventProperties;
        };
        await identifyPrivyUser(this, maybeUser as PrivyUser, {
          // Prefer an explicit override, else the wallet the SDK already treats
          // as active (e.g. from a wagmi/EIP-1193 connect) so this multi-wallet
          // identify doesn't overwrite attribution with Privy's primary wallet.
          activeAddress: opts.activeAddress ?? this.currentAddress,
          properties: opts.properties,
        });
        return;
      }

      const params = paramsOrUser as
        | { address: Address; providerName?: string; userId?: string; rdns?: string }
        | undefined;
      const properties = propertiesOrOptions as IFormoEventProperties | undefined;

      // identify() writes the user-id cookie and marks wallet
      // identification before trackEvent's consent check — gate the whole
      // method so a suppressed visitor or excluded environment (opt-out /
      // timezone / host / path) gets no identity persistence.
      if (this.isTrackingSuppressed()) {
        logger.info("identify() skipped: tracking is suppressed for this visitor or environment");
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
                      providerDetail.info.rdns
                    )
                  : false,
              });

              if (
                validAddress &&
                !this.session.isWalletIdentified(
                  validAddress,
                  providerDetail.info.rdns
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

      const { address, providerName, userId, rdns } = params;

      // Runtime validation: address is required
      if (!address) {
        logger.warn?.("identify() called without address - address is required");
        return;
      }

      // Explicit identify
      logger.info("Identify", address, userId, providerName, rdns);
      const validAddress = validateAddress(address);
      if (validAddress) {
        this.currentAddress = validAddress;
        this.persistActiveWallet();
      } else {
        logger.warn?.("Invalid address provided to identify:", address);
        return;
      }
      if (userId) {
        this.currentUserId = userId;
        const domain = getIdentityCookieDomain(this.crossSubdomainCookies);
        cookie().set(SESSION_USER_ID_KEY, userId, {
          path: "/",
          ...getIdentityCookieSecurity(),
          ...(domain ? { domain } : {}),
        });
      }

      // Check for duplicate identify events in this session. The userId is
      // folded into the dedup key so re-identifying an already-seen wallet with
      // a newly-attached userId (e.g. a Privy DID after login) still emits.
      const isAlreadyIdentified = this.session.isWalletIdentified(
        validAddress,
        rdns || "",
        userId
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
      this.session.markWalletIdentified(validAddress, rdns || "", userId);

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
    // trackEvent's consent check — gate it for a suppressed visitor or
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

      // Register other listeners based on autocapture configuration
      if (this.isAutocaptureEnabled("chain")) {
        this.registerChainChangedListener(provider);
      }

      if (this.isAutocaptureEnabled("connect")) {
        this.registerConnectListener(provider);
      }

      if (this.isAutocaptureEnabled("signature") || this.isAutocaptureEnabled("transaction")) {
        this.registerRequestListeners(provider);
      } else {
        logger.debug("TrackProvider: Skipping request wrapping (both signature and transaction autocapture disabled)");
      }

      if (this.isAutocaptureEnabled("disconnect")) {
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

    // Get chain ID and update state
    const nextChainId = await this.getCurrentChainId(provider);
    const wasDisconnected = !this._evmAddress;

    // Update state regardless of whether connect *event* tracking is enabled,
    // so disconnect events keep valid address/chainId values. (excludeChains is
    // NOT suppression — it still updates state so currentChainId can gate
    // events.)
    if (this.isTrackingSuppressed()) {
      this.clearStaleEvmWalletOnSwitchWhileSuppressed(address);
    } else {
      this.setChainState('evm', { address, chainId: nextChainId });
    }

    // Conditionally emit connect event based on tracking configuration
    const providerInfo = this.getProviderInfo(provider);
    const effectiveChainId = nextChainId || 0;
    
    if (this.isAutocaptureEnabled("connect")) {
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
        return this.chain({
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
      logger.info(
        "OnDisconnect: Wallet disconnect event received, current state:",
        {
          currentAddress: this._evmAddress,
          currentChainId: this._evmChainId,
        }
      );

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

    try {
      if (!connection?.chainId || typeof connection.chainId !== "string")
        return;

      const chainId = parseChainId(connection.chainId);
      const address = await this.getAddress(provider);

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
        // address/chainId values — except while suppressed, where we must not
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

        // Conditionally emit connect event based on tracking configuration
        if (isActiveProvider && this._evmAddress) {
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
      // Handle Signatures
      if (
        Array.isArray(params) &&
        ["eth_signTypedData_v4", "personal_sign"].includes(method)
      ) {
        if (!this.isAutocaptureEnabled("signature")) {
          logger.debug(`Signature event skipped (autocapture.signature: false)`, { method });
          return request({ method, params });
        }
        // Use current chainId if available, otherwise fetch it
        const capturedChainId =
          this._evmChainId || (await this.getCurrentChainId(provider));
        // Fire-and-forget tracking
        (async () => {
          try {
            this.signature({
              status: SignatureStatus.REQUESTED,
              ...this.buildSignatureEventPayload(
                method,
                params,
                undefined,
                capturedChainId
              ),
            });
          } catch (e) {
            logger.error("Formo: Failed to track signature request", e);
          }
        })();

        try {
          const response = (await request({ method, params })) as T;
          // Track signature confirmation only for truthy responses
          if (response) {
            (async () => {
              try {
                this.signature({
                  status: SignatureStatus.CONFIRMED,
                  ...this.buildSignatureEventPayload(
                    method,
                    params,
                    response,
                    capturedChainId
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
                this.signature({
                  status: SignatureStatus.REJECTED,
                  ...this.buildSignatureEventPayload(
                    method,
                    params,
                    undefined,
                    capturedChainId
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
        (async () => {
          try {
            const payload = await this.buildTransactionEventPayload(
              params,
              provider
            );
            this.transaction({ status: TransactionStatus.STARTED, ...payload });
          } catch (e) {
            logger.error("Formo: Failed to track transaction start", e);
          }
        })();

        try {
          const transactionHash = (await request({
            method,
            params,
          })) as string;

          (async () => {
            try {
              const payload = await this.buildTransactionEventPayload(
                params,
                provider
              );
              this.transaction({
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
                  provider
                );
                this.transaction({
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
      this.trackPageHit();
    }
  }

  private trackPageHits(): void {
    // Install a single, instance-agnostic wrapper around history.pushState /
    // replaceState so concurrent SDK instances (React Strict Mode, HMR) don't
    // each stack their own wrapper — which would dispatch N synthetic events
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
      if (!this.shouldTrack()) {
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
   * Returns true when the SDK must not persist any identity/session/chain
   * state or send any events for this visitor — i.e. an explicit opt-out or a
   * jurisdiction/timezone exclusion. Public entry points that write state
   * before reaching the `shouldTrack()` event gate (identify/connect/detect)
   * check this first so suppressed visitors leave no cookies or session state.
   * @returns {boolean} True if all tracking and persistence must be suppressed
   */
  private isTrackingSuppressed(): boolean {
    return this.hasOptedOutTracking() || this.isCurrentEnvironmentExcluded();
  }

  /**
   * Whether the current environment is excluded from tracking — the visitor's
   * timezone, the current hostname, or the current pathname matches a
   * configured exclusion.
   *
   * Timezone is visitor/session-level (stable for the session); host/path are
   * current-page-level and transient — if a SPA navigates to an allowed path,
   * tracking resumes for future actions. Used as the "do not write identity or
   * send events" gate at every entry point that would persist state before the
   * `shouldTrack()` event gate.
   * @returns {boolean} True if the current environment is excluded
   */
  private isCurrentEnvironmentExcluded(): boolean {
    return (
      this.isTimezoneExcluded() ||
      this.isHostExcluded() ||
      this.isPathExcluded()
    );
  }

  /**
   * Whether the current hostname matches a configured `tracking.excludeHosts`
   * entry (exact match). Current-page-level — see isCurrentEnvironmentExcluded.
   * @returns {boolean} True if the current hostname is excluded
   */
  private isHostExcluded(): boolean {
    const tracking = this.options.tracking;
    if (
      tracking === null ||
      typeof tracking !== "object" ||
      Array.isArray(tracking)
    ) {
      return false;
    }
    if (typeof window === "undefined") {
      return false;
    }
    const { excludeHosts = [] } = tracking as TrackingOptions;
    return excludeHosts.includes(window.location.hostname);
  }

  /**
   * Whether the current pathname matches a configured `tracking.excludePaths`
   * entry (exact match). Current-page-level — see isCurrentEnvironmentExcluded.
   * @returns {boolean} True if the current pathname is excluded
   */
  private isPathExcluded(): boolean {
    const tracking = this.options.tracking;
    if (
      tracking === null ||
      typeof tracking !== "object" ||
      Array.isArray(tracking)
    ) {
      return false;
    }
    if (typeof window === "undefined") {
      return false;
    }
    const { excludePaths = [] } = tracking as TrackingOptions;
    return excludePaths.includes(window.location.pathname);
  }

  /**
   * Whether the current call is in a visitor-level suppression state — opt-out
   * or excluded timezone — for which any persisted identity cookie should be
   * actively purged (not merely skipped). Host/path exclusions are
   * deliberately excluded here: they are transient current-page states, so a
   * cookie legitimately written on an allowed page must survive a visit to an
   * excluded route.
   * @returns {boolean} True if persisted identity must be purged
   */
  private isPersistedIdentityPurgeRequired(): boolean {
    return this.hasOptedOutTracking() || this.isTimezoneExcluded();
  }

  /**
   * Whether the visitor's browser-resolved timezone matches a configured
   * `tracking.excludeTimezones` entry (case-insensitive). Client-side and
   * best-effort — see TrackingOptions.excludeTimezones.
   * @returns {boolean} True if the current timezone is excluded
   */
  private isTimezoneExcluded(): boolean {
    const tracking = this.options.tracking;
    if (
      tracking === null ||
      typeof tracking !== "object" ||
      Array.isArray(tracking)
    ) {
      return false;
    }
    const { excludeTimezones = [] } = tracking as TrackingOptions;
    if (excludeTimezones.length === 0) {
      return false;
    }
    const timezone = getTimezone();
    if (!timezone) {
      return false;
    }
    const lowerTimezone = timezone.toLowerCase();
    return excludeTimezones.some(
      (tz) => typeof tz === "string" && tz.toLowerCase() === lowerTimezone
    );
  }

  /**
   * Determines if tracking should be enabled based on configuration and consent
   * @returns {boolean} True if tracking should be enabled
   */
  private shouldTrack(): boolean {
    // First check if user has opted out of tracking
    if (this.hasOptedOutTracking()) {
      return false;
    }

    // Check if tracking is explicitly provided as a boolean
    if (typeof this.options.tracking === "boolean") {
      return this.options.tracking;
    }

    // Handle object configuration with exclusion rules
    if (
      this.options.tracking !== null &&
      typeof this.options.tracking === "object" &&
      !Array.isArray(this.options.tracking)
    ) {
      const { excludeChains = [] } = this.options.tracking as TrackingOptions;

      // Environment exclusions (timezone / host / path) — no identify / connect
      // / track events while excluded. Host/path are exact-match.
      if (this.isCurrentEnvironmentExcluded()) {
        return false;
      }

      // Check chainId exclusions
      if (
        excludeChains.length > 0 &&
        this.currentChainId &&
        excludeChains.includes(this.currentChainId)
      ) {
        return false;
      }

      // If nothing is excluded, tracking is enabled
      return true;
    }

    // Default behavior: track everywhere except localhost
    return !isLocalhost();
  }

  /**
   * Check if a specific wallet event type is enabled for autocapture
   * @param eventType The wallet event type to check
   * @returns {boolean} True if the event type should be autocaptured
   */
  public isAutocaptureEnabled(
    eventType:
      | "connect"
      | "disconnect"
      | "signature"
      | "transaction"
      | "chain"
  ): boolean {
    // If no configuration provided, default to enabled
    if (this.options.autocapture === undefined) {
      return true;
    }

    // If boolean, return that value for all events
    if (typeof this.options.autocapture === "boolean") {
      return this.options.autocapture;
    }

    // If it's an object, check the specific event configuration
    if (
      this.options.autocapture !== null &&
      typeof this.options.autocapture === "object"
    ) {
      const eventConfig = this.options.autocapture[eventType];
      // Default to true if not explicitly set to false
      return eventConfig !== false;
    }

    // Default to enabled if no specific configuration
    return true;
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
    chainId?: number
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
    this.backfillActiveWallet(validAddress, effectiveChainId);

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
    provider?: EIP1193Provider
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

    const chainId = this._evmChainId || (await this.getCurrentChainId(provider));
    this.backfillActiveWallet(validAddress, chainId);

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
  private backfillActiveWallet(address: Address, chainId?: ChainID): void {
    // Never learn identity while suppressed (opt-out / timezone / excluded host
    // or path). A signature/transaction observed on an excluded route must not
    // populate currentAddress for later allowed-page events. backfill only ever
    // *adds* an address (it no-ops when one is already known), so there is no
    // stale state to clear here.
    if (this.isTrackingSuppressed()) return;
    if (this._evmAddress) return;
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
    if ('address' in update) ns.address = update.address;
    if ('chainId' in update) {
      ns.chainId = update.chainId;
    } else if (typeof namespaceOrChainId === 'number') {
      ns.chainId = namespaceOrChainId;
    }
    if (namespace === 'evm' && 'provider' in update) {
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
   * connect / chain-change / disconnect — even when the corresponding
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
      // never LEARN a new wallet — but we must still CLEAR stale identity.
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
   * page load — closing the gap between page-show and wagmi/EIP-1193
   * reconnection during which track()/page() events would otherwise ship
   * with an empty address.
   */
  private persistActiveWallet(): void {
    try {
      // Visitor-level suppression (opt-out or excluded timezone): purge any
      // prior snapshot — these are stable for the session, so deletion is safe.
      if (this.isPersistedIdentityPurgeRequired()) {
        cookie().remove(ACTIVE_WALLET_KEY);
        return;
      }
      if (this.currentAddress) {
        // Current-page exclusion (host/path): do not write a new snapshot while
        // on an excluded route, but leave any existing cookie intact. A cookie
        // written on an allowed page must survive a transient visit to an
        // excluded one (passive navigation does not call this method).
        if (this.isHostExcluded() || this.isPathExcluded()) {
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
      if (this.isHostExcluded() || this.isPathExcluded()) {
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
