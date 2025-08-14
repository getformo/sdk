import { createStore, EIP6963ProviderDetail } from "mipd";
import {
  EVENTS_API_URL,
  EventType,
  LOCAL_ANONYMOUS_ID_KEY,
  SESSION_CURRENT_URL_KEY,
  SESSION_USER_ID_KEY,
  SESSION_WALLET_DETECTED_KEY,
  TEventType,
} from "./constants";
import {
  cookie,
  EventManager,
  EventQueue,
  IEventManager,
  initStorageManager,
  logger,
  Logger,
} from "./lib";
import {
  Address,
  ChainID,
  Config,
  EIP1193Provider,
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
} from "./types";
import { toChecksumAddress } from "./utils";
import { isValidAddress, getValidAddress } from "./utils/address";
import { isAddress, isLocalhost } from "./validators";
import { parseChainId } from "./utils/chain";

const WRAPPED_REQUEST_SYMBOL = Symbol("formoWrappedRequest");

export class FormoAnalytics implements IFormoAnalytics {
  private _provider?: EIP1193Provider;
  private _trackedProviders: Set<EIP1193Provider> = new Set();
  private _providerListenersMap: WeakMap<EIP1193Provider, Record<string, (...args: unknown[]) => void>> = new WeakMap();
  private _wrappedRequestProviders: WeakSet<EIP1193Provider> = new WeakSet();
  private session: FormoAnalyticsSession;
  private eventManager: IEventManager;
  private _providers: readonly EIP6963ProviderDetail[] = [];

  config: Config;
  currentChainId?: ChainID;
  currentAddress?: Address;
  currentUserId?: string = "";

  private constructor(
    public readonly writeKey: string,
    public options: Options = {}
  ) {
    this.config = {
      writeKey,
    };
    this.options = options;

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

    // Initialize logger with configuration from options
    Logger.init({
      enabled: options.logger?.enabled || false,
      enabledLevels: options.logger?.levels || [],
    });

    this.eventManager = new EventManager(
      new EventQueue(this.config.writeKey, {
        url: EVENTS_API_URL,
        flushAt: options.flushAt,
        retryCount: options.retryCount,
        maxQueueSize: options.maxQueueSize,
        flushInterval: options.flushInterval,
      })
    );

    // Handle initial provider (injected) as fallback; listeners for EIP-6963 are added later
    const provider = (options.provider as EIP1193Provider | undefined) || (typeof window !== 'undefined' ? window.ethereum : undefined);
    if (provider) {
      this.trackProvider(provider);
    }

    this.trackPageHit();
    this.trackPageHits();
  }

  static async init(
    writeKey: string,
    options?: Options
  ): Promise<FormoAnalytics> {
    initStorageManager(writeKey);
    const analytics = new FormoAnalytics(writeKey, options);

    // Auto-detect wallet provider
    analytics._providers = await analytics.getProviders();
    await analytics.detectWallets(analytics._providers);
    analytics.trackProviders(analytics._providers);

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
    cookie().remove(LOCAL_ANONYMOUS_ID_KEY);
    cookie().remove(SESSION_USER_ID_KEY);
  }

  /**
   * Emits a connect wallet event.
   * @param {ChainID} params.chainId
   * @param {Address} params.address
   * @param {IFormoEventProperties} properties
   * @param {IFormoEventContext} context
   * @param {(...args: unknown[]) => void} callback
   * @throws {Error} If chainId or address is empty
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
    if (!chainId) {
      logger.warn("Connect: Chain ID cannot be empty");
    }
    if (!address) {
      logger.warn("Connect: Address cannot be empty");
    }

    this.currentChainId = chainId;
    const validAddress = getValidAddress(address);
    this.currentAddress = validAddress ? toChecksumAddress(validAddress) : undefined;

    await this.trackEvent(
      EventType.CONNECT,
      {
        chainId,
        address: this.currentAddress,
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

    await this.trackEvent(
      EventType.DISCONNECT,
      {
        chainId,
        address,
      },
      properties,
      context,
      callback
    );

    this.currentAddress = undefined;
    this.currentChainId = undefined;
    logger.info("Wallet disconnected: Cleared currentAddress and currentChainId");    
  }

  /**
   * Emits a chain network change event.
   * @param {ChainID} params.chainId
   * @param {Address} params.address
   * @param {IFormoEventProperties} properties
   * @param {IFormoEventContext} context
   * @param {(...args: unknown[]) => void} callback
   * @throws {Error} If chainId is empty, zero, or not a valid number
   * @throws {Error} If no address is provided and no previous address is recorded
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
      throw new Error("FormoAnalytics::chain: chainId cannot be empty or 0");
    }
    if (isNaN(Number(chainId))) {
      throw new Error(
        "FormoAnalytics::chain: chainId must be a valid decimal number"
      );
    }
    if (!address && !this.currentAddress) {
      throw new Error(
        "FormoAnalytics::chain: address was empty and no previous address has been recorded"
      );
    }

    this.currentChainId = chainId;

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
   * @param {string} params.signatureHash - only provided if status is confirmed
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
      signatureHash,
    }: {
      status: SignatureStatus;
      chainId?: ChainID;
      address: Address;
      message: string;
      signatureHash?: string;
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
        ...(signatureHash && { signatureHash }),
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
    }: {
      status: TransactionStatus;
      chainId: ChainID;
      address: Address;
      data?: string;
      to?: string;
      value?: string;
      transactionHash?: string;
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
      },
      properties,
      context,
      callback
    );
  }

  /**
   * Emits an identify event with current wallet address and provider info.
   * @param {string} params.address
   * @param {string} params.userId
   * @param {string} params.rdns
   * @param {string} params.providerName
   * @param {IFormoEventProperties} properties
   * @param {IFormoEventContext} context
   * @param {(...args: unknown[]) => void} callback
   * @returns {Promise<void>}
   */
  async identify(
    params?: {
      address?: Address;
      providerName?: string;
      userId?: string;
      rdns?: string;
    },
    properties?: IFormoEventProperties,
    context?: IFormoEventContext,
    callback?: (...args: unknown[]) => void
  ): Promise<void> {
    try {
      if (!params) {
        // If no params provided, auto-identify
        logger.info(
          "Auto-identifying with providers:",
          this._providers.map((p) => p.info.name)
        );
        for (const providerDetail of this._providers) {
          const provider = providerDetail.provider;
          if (!provider) continue;

          try {
            const address = await this.getAddress(provider);
            if (address) {
              logger.info(
                "Auto-identifying",
                address,
                providerDetail.info.name,
                providerDetail.info.rdns
              );
              // NOTE: do not set this.currentAddress without explicit connect or identify
              await this.identify(
                {
                  address,
                  providerName: providerDetail.info.name,
                  rdns: providerDetail.info.rdns,
                },
                properties,
                context,
                callback
              );
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

      // Explicit identify
      const { userId, address, providerName, rdns } = params;
      logger.info("Identify", address, userId, providerName, rdns);
      const validAddress = getValidAddress(address);
      if (validAddress) this.currentAddress = toChecksumAddress(validAddress);
      if (userId) {
        this.currentUserId = userId;
        cookie().set(SESSION_USER_ID_KEY, userId);
      }

      await this.trackEvent(
        EventType.IDENTIFY,
        {
          address: validAddress ? toChecksumAddress(validAddress) : undefined,
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
    SDK tracking and event listener functions
  */

  private trackProvider(provider: EIP1193Provider): void {
    logger.info("trackProvider", provider);
    try {
      if (!provider) return;
      if (this._trackedProviders.has(provider)) {
        logger.warn("TrackProvider: Provider already tracked.");
        return;
      }

      this._trackedProviders.add(provider);

      // Register listeners for this provider
      this.registerAccountsChangedListener(provider);
      this.registerChainChangedListener(provider);
      this.registerConnectListener(provider);
      this.registerRequestListeners(provider);
      this.registerDisconnectListener(provider);
    } catch (error) {
      logger.error("Error tracking provider:", error);
    }
  }

  private trackProviders(providers: readonly EIP6963ProviderDetail[]): void {
    try {
      for (const eip6963ProviderDetail of providers) {
        const provider = eip6963ProviderDetail?.provider as EIP1193Provider | undefined;
        if (provider) {
          this.trackProvider(provider);
        }
      }
    } catch (error) {
      logger.error("Error tracking providers:", error);
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

  private async onAccountsChanged(provider: EIP1193Provider, accounts: Address[]): Promise<void> {
    logger.info("onAccountsChanged", accounts);
    if (accounts.length === 0) {
      // Handle wallet disconnect for active provider only
      if (this.isCurrentOrNoProvider(provider)) {
        await this.disconnect();
        if (this._provider === provider) {
          this._provider = undefined;
        }
        // Proactively remove listeners to avoid leaks
        this.removeProviderListeners(provider);
      }
      return;
    }
    
    // Validate the first account is a valid address before processing
    const validAddress = getValidAddress(accounts[0]);
    if (!validAddress) {
      logger.warn("onAccountsChanged: Invalid address received", accounts[0]);
      return;
    }
    
    const address = toChecksumAddress(validAddress);
    // If the same provider emits the same address, no-op. Allow provider switches even if address is the same.
    if (address === this.currentAddress && this._provider === provider) {
      return;
    }

    // Switch active provider to the one that emitted the event
    this._provider = provider;
    this.currentAddress = address;
    this.currentChainId = await this.getCurrentChainId(provider);
    this.connect({ chainId: this.currentChainId, address });
  }

  private registerChainChangedListener(provider: EIP1193Provider): void {
    logger.info("registerChainChangedListener");
    const listener = (...args: unknown[]) =>
      this.onChainChanged(provider, args[0] as string);
    provider.on("chainChanged", listener);
    this.addProviderListener(provider, "chainChanged", listener);
  }

  private async onChainChanged(provider: EIP1193Provider, chainIdHex: string): Promise<void> {
    logger.info("onChainChanged", chainIdHex);
    const nextChainId = parseChainId(chainIdHex);

    // Only handle chain changes for the active provider (or if none is set yet)
    if (this._provider && this._provider !== provider) {
      return;
    }
    if (!this._provider) {
      // Select provider if none is active yet
      this._provider = provider;
    }

    this.currentChainId = nextChainId;

    if (!this.currentAddress) {
      const address = await this.getAddress(provider);
      if (!address) {
        logger.info(
          "OnChainChanged: Unable to fetch or store connected address"
        );
        return Promise.resolve();
      }
      const validAddress = getValidAddress(address);
      this.currentAddress = validAddress ? toChecksumAddress(validAddress) : undefined;
    }

    // Proceed only if the address exists
    if (this.currentAddress) {
      return this.chain({
        chainId: this.currentChainId,
        address: this.currentAddress,
      });
    } else {
      logger.info(
        "OnChainChanged: Current connected address is null despite fetch attempt"
      );
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
    const listener = (_error?: unknown) => {
      if (this.isCurrentOrNoProvider(provider)) {
        this.disconnect();
        if (this._provider === provider) {
          this._provider = undefined;
        }
        // Proactively remove listeners to avoid leaks
        this.removeProviderListeners(provider);
      }
    };
    provider.on("disconnect", listener);
    this.addProviderListener(provider, "disconnect", listener);
  }

  private async onConnected(provider: EIP1193Provider, connection: ConnectInfo): Promise<void> {
    logger.info("onConnected", connection);
    try {
      if (!connection || typeof connection.chainId !== 'string') return;
      const chainId = parseChainId(connection.chainId);
      const address = await this.getAddress(provider);
      if (chainId !== null && chainId !== undefined && address) {
        this._provider = provider;
        this.currentChainId = chainId;
        this.connect({ chainId, address });
      }
    } catch (e) {
      logger.error("Error handling connect event", e);
    }
  }

  private registerRequestListeners(provider: EIP1193Provider): void {
    logger.info("registerRequestListeners");
    if (!provider) {
      logger.error("Provider not found for request (signature, transaction) tracking");
      return;
    }

    const descriptor = Object.getOwnPropertyDescriptor(provider, "request");
    if (descriptor && descriptor.writable === false) {
      logger.warn("Provider.request is not writable");
      return;
    }
    if (descriptor && descriptor.get && !descriptor.set) {
      logger.warn("Provider.request is an accessor without a setter; skipping wrap");
      return;
    }

    // If already wrapped and request is still our wrapped version, skip wrapping. If replaced, allow re-wrap.
    const currentRequest = provider.request as any;
    if (
      this._wrappedRequestProviders.has(provider) &&
      currentRequest && currentRequest[WRAPPED_REQUEST_SYMBOL]
    ) {
      logger.debug("Provider already wrapped; skipping request wrapping.");
      return;
    }
    if (
      this._wrappedRequestProviders.has(provider) &&
      (!currentRequest || !currentRequest[WRAPPED_REQUEST_SYMBOL])
    ) {
      this._wrappedRequestProviders.delete(provider);
    }

    const request = provider.request.bind(provider);

    const wrappedRequest = async <T>({
      method,
      params,
    }: RequestArguments): Promise<T | null | undefined> => {
      // Handle Signatures
      if (
        Array.isArray(params) &&
        ["eth_signTypedData_v4", "personal_sign"].includes(method)
      ) {
        const chainId = this.currentChainId || (await this.getCurrentChainId(provider));
        // Fire-and-forget tracking
        (async () => {
          try {
            this.signature({
              status: SignatureStatus.REQUESTED,
              ...this.buildSignatureEventPayload(method, params, undefined, chainId),
            });
          } catch (e) {
            logger.error("Formo: Failed to track signature request", e);
          }
        })();

        try {
          const response = (await request({ method, params })) as T;
          (async () => {
            try {
              if (response) {
                this.signature({
                  status: SignatureStatus.CONFIRMED,
                  ...this.buildSignatureEventPayload(method, params, response, chainId),
                });
              }
            } catch (e) {
              logger.error("Formo: Failed to track signature confirmation", e);
            }
          })();
          return response;
        } catch (error) {
          (async () => {
            try {
              const rpcError = error as RPCError;
              if (rpcError && rpcError?.code === 4001) {
                this.signature({
                  status: SignatureStatus.REJECTED,
                  ...this.buildSignatureEventPayload(method, params, undefined, chainId),
                });
              }
            } catch (e) {
              logger.error("Formo: Failed to track signature rejection", e);
            }
          })();
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
        (async () => {
          try {
            const payload = await this.buildTransactionEventPayload(params, provider);
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
              const payload = await this.buildTransactionEventPayload(params, provider);
              this.transaction({
                status: TransactionStatus.BROADCASTED,
                ...payload,
                transactionHash,
              });

              // Start async polling for transaction receipt
              this.pollTransactionReceipt(provider, transactionHash, payload);
            } catch (e) {
              logger.error(
                "Formo: Failed to track transaction broadcast",
                e
              );
            }
          })();

          return transactionHash as unknown as T;
        } catch (error) {
          (async () => {
            try {
              const rpcError = error as RPCError;
              if (rpcError && rpcError?.code === 4001) {
                const payload = await this.buildTransactionEventPayload(
                  params,
                  provider
                );
                this.transaction({
                  status: TransactionStatus.REJECTED,
                  ...payload,
                });
              }
            } catch (e) {
              logger.error("Formo: Failed to track transaction rejection", e);
            }
          })();
          throw error;
        }
      }

      return request({ method, params });
    };
    // Mark the wrapper so we can detect if request is replaced externally
    (wrappedRequest as any)[WRAPPED_REQUEST_SYMBOL] = true;

    try {
      // Prefer a type-safe assignment when possible
      if (this.isMutableEIP1193Provider(provider)) {
        provider.request = wrappedRequest as typeof provider.request;
        this._wrappedRequestProviders.add(provider);
      } else {
        logger.warn("Provider.request is not writable or not a function; skipping wrap");
      }
    } catch (e) {
      logger.warn("Failed to wrap provider.request; skipping", e);
    }
  }

  private async onLocationChange(): Promise<void> {
    const currentUrl = cookie().get(SESSION_CURRENT_URL_KEY);

    if (currentUrl !== window.location.href) {
      cookie().set(SESSION_CURRENT_URL_KEY, window.location.href);
      this.trackPageHit();
    }
  }

  private async trackPageHits(): Promise<void> {
    const oldPushState = history.pushState;
    history.pushState = function pushState(...args) {
      const ret = oldPushState.apply(this, args);
      window.dispatchEvent(new window.Event("locationchange"));
      return ret;
    };

    const oldReplaceState = history.replaceState;
    history.replaceState = function replaceState(...args) {
      const ret = oldReplaceState.apply(this, args);
      window.dispatchEvent(new window.Event("locationchange"));
      return ret;
    };

    window.addEventListener("popstate", () => this.onLocationChange());
    window.addEventListener("locationchange", () => this.onLocationChange());
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

    setTimeout(async () => {
      this.trackEvent(
        EventType.PAGE,
        {
          category,
          name,
        },
        properties,
        context,
        callback
      );
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

      this.eventManager.addEvent(
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
   * Determines if tracking should be enabled based on configuration
   * @returns {boolean} True if tracking should be enabled
   */
  private shouldTrack(): boolean {
    // Check if tracking is explicitly provided as a boolean
    if (typeof this.options.tracking === 'boolean') {
      return this.options.tracking;
    }
    
    // Handle object configuration with exclusion rules
    if (this.options.tracking !== null && 
        typeof this.options.tracking === 'object' && 
        !Array.isArray(this.options.tracking)) {
      const { 
        excludeHosts = [],
        excludePaths = [], 
        excludeChains = [] 
      } = this.options.tracking as TrackingOptions;
      
      // Check hostname exclusions - use exact matching
      if (excludeHosts.length > 0  && typeof window !== 'undefined') {
        const hostname = window.location.hostname;
        if (excludeHosts.includes(hostname)) {
          return false;
        }
      }
      
      // Check path exclusions - use exact matching
      if (excludePaths.length > 0 && typeof window !== 'undefined') {
        const pathname = window.location.pathname;
        if (excludePaths.includes(pathname)) {
          return false;
        }
      }
      
      // Check chainId exclusions
      if (excludeChains.length > 0 && 
          this.currentChainId && 
          excludeChains.includes(this.currentChainId)) {
        return false;
      }
      
      // If nothing is excluded, tracking is enabled
      return true;
    }
    
    // Default behavior: track everywhere except localhost
    return !isLocalhost();
  }

  /*
    Utility functions
  */

  private async getProviders(): Promise<readonly EIP6963ProviderDetail[]> {
    const store = createStore();
    let providers = store.getProviders();
    store.subscribe((providerDetails) => {
      providers = providerDetails;
      this._providers = providers;
      // Track listeners for newly discovered providers only
      const newDetails = providerDetails.filter((detail) => {
        const p = detail?.provider as EIP1193Provider | undefined;
        return !!p && !this._trackedProviders.has(p);
      });
      if (newDetails.length > 0) {
        this.trackProviders(newDetails);
      }
      // Detect newly discovered wallets (session de-dupes)
      this.detectWallets(providerDetails);
    });

    // Fallback to injected provider if no providers are found
    if (providers.length === 0) {
      this._providers = [];
      const injected = typeof window !== 'undefined' ? window.ethereum : undefined;
      if (injected) {
        this.trackProvider(injected);
      }
      return this._providers;
    }
    this._providers = providers;
    return providers;
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

  private async getAddress(
    provider?: EIP1193Provider
  ): Promise<Address | null> {
    if (this.currentAddress) return this.currentAddress;
    const p = provider || this.provider;
    if (!p) {
      logger.info("The provider is not set");
      return null;
    }

    try {
      const accounts = await this.getAccounts(p);
      if (accounts && accounts.length > 0) {
        const validAddress = getValidAddress(accounts[0]);
        if (validAddress) {
          return toChecksumAddress(validAddress);
        }
      }
    } catch (err) {
      logger.error("Failed to fetch accounts from provider:", err);
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
        .map((e) => getValidAddress(e))
        .filter((e): e is string => e !== null)
        .map(toChecksumAddress);
    } catch (err) {
      const code = (err as { code?: number } | undefined)?.code;
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
    }

    let chainIdHex;
    try {
      chainIdHex = await p?.request<string>({
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
    response?: unknown,
    chainId?: number
  ) {
    const rawAddress = method === "personal_sign"
      ? (params[1] as Address)
      : (params[0] as Address);
    
    const validAddress = getValidAddress(rawAddress);
    if (!validAddress) {
      throw new Error(`Invalid address in signature payload: ${rawAddress}`);
    }
    
    const basePayload = {
      chainId: chainId ?? this.currentChainId,
      address: toChecksumAddress(validAddress),
    };

    if (method === "personal_sign") {
      const message = Buffer.from(
        (params[0] as string).slice(2),
        "hex"
      ).toString("utf8");
      return {
        ...basePayload,
        message,
        ...(response ? { signatureHash: response as string } : {}),
      };
    }

    return {
      ...basePayload,
      message: params[1] as string,
      ...(response ? { signatureHash: response as string } : {}),
    };
  }

  private async buildTransactionEventPayload(params: unknown[], provider?: EIP1193Provider) {
    const { data, from, to, value } = params[0] as {
      data: string;
      from: string;
      to: string;
      value: string;
    };
    
    const validAddress = getValidAddress(from);
    if (!validAddress) {
      throw new Error(`Invalid address in transaction payload: ${from}`);
    }
    
    return {
      chainId: this.currentChainId || (await this.getCurrentChainId(provider)),
      data,
      address: toChecksumAddress(validAddress),
      to,
      value,
    };
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

  private isCurrentOrNoProvider(provider: EIP1193Provider | undefined): boolean {
    return !this._provider || this._provider === provider;
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

  private isMutableEIP1193Provider(provider: EIP1193Provider): provider is EIP1193Provider & { request: typeof provider.request } {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(provider, "request");
      if (descriptor && (descriptor.writable === false || (descriptor.get && !descriptor.set))) {
        return false;
      }
    } catch {
      return false;
    }
    return typeof (provider as any).request === "function";
  }

  // Explicitly untrack a provider: remove listeners, clear wrapper flag and tracking
  public untrackProvider(provider: EIP1193Provider): void {
    try {
      this.removeProviderListeners(provider);
      this._wrappedRequestProviders.delete(provider);
      this._trackedProviders.delete(provider);
      if (this._provider === provider) {
        this._provider = undefined;
      }
    } catch (e) {
      logger.warn("Failed to untrack provider", e);
    }
  }
}

interface IFormoAnalyticsSession {
  isWalletDetected(rdns: string): boolean;
  markWalletDetected(rdns: string): void;
}

class FormoAnalyticsSession implements IFormoAnalyticsSession {
  public isWalletDetected(rdns: string): boolean {
    const rdnses = cookie().get(SESSION_WALLET_DETECTED_KEY)?.split(",") || [];
    return rdnses.includes(rdns);
  }

  public markWalletDetected(rdns: string): void {
    const rdnses = cookie().get(SESSION_WALLET_DETECTED_KEY)?.split(",") || [];
    rdnses.push(rdns);
    cookie().set(SESSION_WALLET_DETECTED_KEY, rdnses.join(","), {
      // by the end of the day
      expires: new Date(Date.now() + 86400 * 1000).toUTCString(),
      path: "/",
    });
  }
}
