import { createStore, EIP6963ProviderDetail } from "mipd";
import {
  EVENTS_API_URL,
  EventType,
  LOCAL_ANONYMOUS_ID_KEY,
  SESSION_CURRENT_URL_KEY,
  SESSION_USER_ID_KEY,
  SESSION_WALLET_DETECTED_KEY,
  TEventType,
  DEFAULT_PROVIDER_ICON,
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
  WrappedEIP1193Provider,
  WrappedRequestFunction,
  WRAPPED_REQUEST_SYMBOL,
  WRAPPED_REQUEST_REF_SYMBOL,
} from "./types";
import { toChecksumAddress } from "./utils";
import { isValidAddress, getValidAddress } from "./utils/address";
import { isAddress, isLocalhost } from "./validators";
import { parseChainId } from "./utils/chain";

export class FormoAnalytics implements IFormoAnalytics {
  private _provider?: EIP1193Provider;
  private _trackedProviders: Set<EIP1193Provider> = new Set();
  private _providerListenersMap: WeakMap<EIP1193Provider, Record<string, (...args: unknown[]) => void>> = new WeakMap();
  private session: FormoAnalyticsSession;
  private eventManager: IEventManager;
  private _providers: readonly EIP6963ProviderDetail[] = [];
  // Remove global tokens and replace with provider-specific tracking
  private _providerOperationMap: WeakMap<EIP1193Provider, {
    accountsChanged: Symbol;
    chainChanged: Symbol;
    connected: Symbol;
  }> = new WeakMap();
  
  // Track which provider the cached chainId belongs to to avoid unnecessary network requests
  private _chainIdProvider?: EIP1193Provider;

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
    return !!(this._provider && this._provider !== provider);
  }

  /**
   * Get or create operation tokens for a specific provider
   * @param provider The provider to get tokens for
   * @returns Object containing operation tokens
   */
  private getProviderOperationTokens(provider: EIP1193Provider) {
    let tokens = this._providerOperationMap.get(provider);
    if (!tokens) {
      tokens = {
        accountsChanged: Symbol(),
        chainChanged: Symbol(),
        connected: Symbol(),
      };
      this._providerOperationMap.set(provider, tokens);
    }
    return tokens;
  }

  /**
   * Check if an operation token is still valid for a provider
   * @param provider The provider to check
   * @param operationType The type of operation
   * @param token The token to validate
   * @returns true if the token is still valid
   */
  private isOperationTokenValid(
    provider: EIP1193Provider,
    operationType: 'accountsChanged' | 'chainChanged' | 'connected',
    token: Symbol
  ): boolean {
    const tokens = this._providerOperationMap.get(provider);
    return !!(tokens && tokens[operationType] && tokens[operationType] === token);
  }

  /**
   * Invalidate operation tokens for a provider when switching away from it
   * @param provider The provider to invalidate tokens for
   */
  private invalidateProviderOperationTokens(provider: EIP1193Provider): void {
    this._providerOperationMap.delete(provider);
  }

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
    let provider: EIP1193Provider | undefined = undefined;
    const optProvider = options.provider as EIP1193Provider | undefined;
    if (optProvider) {
      provider = optProvider;
    } else if (typeof window !== 'undefined' && window.ethereum) {
      provider = window.ethereum;
    }
    
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
    this.currentAddress = this.validateAndChecksumAddress(address);

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
      this.currentAddress = address ? this.validateAndChecksumAddress(address) : undefined;
      if (userId) {
        this.currentUserId = userId;
        cookie().set(SESSION_USER_ID_KEY, userId);
      }

      await this.trackEvent(
        EventType.IDENTIFY,
        {
          address: address ? this.validateAndChecksumAddress(address) : undefined,
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
      logger.error("Failed to track EIP-6963 providers during initialization:", error);
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

  private async onAccountsChanged(provider: EIP1193Provider, accounts: string[]): Promise<void> {
    logger.info("onAccountsChanged", accounts);
    
    // Generate a unique token for this operation to prevent race conditions
    const tokens = this.getProviderOperationTokens(provider);
    const token = Symbol();
    tokens.accountsChanged = token;

    if (accounts.length === 0) {
      // Handle wallet disconnect for active provider only
      if (this._provider === provider) {
        try {
          await this.disconnect();
          // Provider remains tracked to allow for reconnection scenarios
        } catch (error) {
          logger.error("Failed to disconnect provider on accountsChanged", error);
          // Don't untrack if disconnect failed to maintain state consistency
        }
      }
      return;
    }
    
    // Validate the first account is a valid address before processing
    const validAddress = getValidAddress(accounts[0]);
    if (!validAddress) {
      logger.warn("onAccountsChanged: Invalid address received", accounts[0]);
      return;
    }
    
    const address = validAddress ? toChecksumAddress(validAddress) : undefined;
    
    // If no valid address, skip processing
    if (!address) {
      logger.warn("onAccountsChanged: No valid address found");
      return;
    }
    
    // If both the provider and address are the same, no-op. Allow provider switches even if address is the same.
    if (this._provider === provider && address === this.currentAddress) {
      return;
    }

    // Prepare new chainId first to avoid race; do not mutate state yet
    const nextChainId = await this.getCurrentChainId(provider);
    // If another provider became active while awaiting, abort (token check)
    if (!this.isOperationTokenValid(provider, 'accountsChanged', token)) return;

    // Allow provider switching - remove the restrictive provider mismatch check
    // Only prevent switching if we're in the middle of another operation with the same provider
    if (this._provider && this._provider !== provider) {
      // If we have a different active provider, allow the switch but invalidate the old provider's tokens
      this.invalidateProviderOperationTokens(this._provider);
    }

    // Commit new active provider and state
    this._provider = provider;
    this.currentAddress = address;
    this.currentChainId = nextChainId;
    // Fire-and-forget analytics tracking - don't block the critical path
    this.connect({ chainId: this.currentChainId, address }).catch(error => {
      logger.error("Failed to track connect event in onAccountsChanged:", error);
    });
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
    
    // Generate a unique token for this operation to prevent race conditions
    const tokens = this.getProviderOperationTokens(provider);
    const token = Symbol();
    tokens.chainChanged = token;
    
    const nextChainId = parseChainId(chainIdHex);

    // Only handle chain changes for the active provider (or if none is set yet)
    if (this.isProviderMismatch(provider)) {
      // If this is a different provider, allow the switch but invalidate old provider tokens
      this.invalidateProviderOperationTokens(this._provider!);
      this._provider = provider;
    }

    // Avoid mutating provider until we have required data
    let addressToUse: Address | undefined = this.currentAddress;

    if (!addressToUse) {
      const fetched = await this.getAddress(provider);
      // Check token after async operation
      if (!this.isOperationTokenValid(provider, 'chainChanged', token)) return;
      
      if (!fetched) {
        logger.info(
          "OnChainChanged: Unable to fetch or store connected address"
        );
        return Promise.resolve();
      }
      addressToUse = this.validateAndChecksumAddress(fetched);
    }

    // If another provider became active while awaiting, abort
    if (!this.isOperationTokenValid(provider, 'chainChanged', token)) return;
    
    // Set provider if none exists
    if (!this._provider) {
      this._provider = provider;
    }
    
    this.currentChainId = nextChainId;

    // Proceed only if the address exists
    if (addressToUse) {
      this.currentAddress = addressToUse;
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
    const listener = async (_error?: unknown) => {
      if (this._provider !== provider) return;
      try {
        await this.disconnect();
        // Provider remains tracked to allow for reconnection scenarios
      } catch (e) {
        logger.error("Error during disconnect in disconnect listener", e);
        // Don't untrack if disconnect failed to maintain state consistency
      }
    };
    provider.on("disconnect", listener);
    this.addProviderListener(provider, "disconnect", listener);
  }

  private async onConnected(provider: EIP1193Provider, connection: ConnectInfo): Promise<void> {
    logger.info("onConnected", connection);
    
    // Generate a unique token for this operation to prevent race conditions
    const tokens = this.getProviderOperationTokens(provider);
    const token = Symbol();
    tokens.connected = token;
    
    try {
      if (!connection || typeof connection.chainId !== 'string') return;
      const chainId = parseChainId(connection.chainId);
      const address = await this.getAddress(provider);
      
      // Check token after async operation
      if (!this.isOperationTokenValid(provider, 'connected', token)) return;
      
      // Allow provider switching - remove the restrictive provider mismatch check
      // Only prevent switching if we're in the middle of another operation with the same provider
      if (this._provider && this._provider !== provider) {
        // If we have a different active provider, allow the switch but invalidate the old provider's tokens
        this.invalidateProviderOperationTokens(this._provider);
      }
      
      if (chainId !== null && chainId !== undefined && address) {
        // Set provider if none exists
        if (!this._provider) {
          this._provider = provider;
        }
        
        this.currentChainId = chainId;
        // Fire-and-forget analytics tracking - don't block the critical path
        this.connect({ chainId, address }).catch(error => {
          logger.error("Failed to track connect event in onConnected:", error);
        });
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

    const isMutable = this.isMutableEIP1193Provider(provider);
    // Removed redundant mutability check; rely on try-catch below for assignment errors.

    // If already wrapped and request is still our wrapped version, skip wrapping. If replaced, allow re-wrap.
    const currentRequest = provider.request as WrappedRequestFunction;
    if (
      currentRequest &&
      typeof currentRequest === 'function' &&
      currentRequest[WRAPPED_REQUEST_SYMBOL] &&
      (provider as any)[WRAPPED_REQUEST_REF_SYMBOL] === currentRequest
    ) {
      logger.debug("Provider already wrapped; skipping request wrapping.");
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
        // Capture chainId once to avoid race conditions
        let capturedChainId: number | undefined = undefined;
        // Only use cached chainId if it's for the same provider instance
        if (this.currentChainId != null && this._chainIdProvider === provider) {
          capturedChainId = this.currentChainId;
        } else {
          capturedChainId = await this.getCurrentChainId(provider);
          this.currentChainId = capturedChainId;
          this._chainIdProvider = provider;
        }
        // Fire-and-forget tracking
        (async () => {
          try {
            this.signature({
              status: SignatureStatus.REQUESTED,
              ...this.buildSignatureEventPayload(method, params, undefined, capturedChainId),
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
                ...this.buildSignatureEventPayload(method, params, response, capturedChainId),
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
                  ...this.buildSignatureEventPayload(method, params, undefined, capturedChainId),
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
    // Mark the wrapper so we can detect if request is replaced externally and keep a reference on provider
    wrappedRequest[WRAPPED_REQUEST_SYMBOL] = true;
    (provider as WrappedEIP1193Provider)[WRAPPED_REQUEST_REF_SYMBOL] = wrappedRequest;

    try {
      // Prefer a type-safe assignment when possible
      if (isMutable) {
        provider.request = wrappedRequest;
      } else {
        logger.warn("Cannot wrap provider.request: property is not writable");
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

  /**
   * Check if a provider's request method can be wrapped/modified
   * @param provider The provider to check
   * @returns true if the provider's request method is mutable
   */
  private isMutableEIP1193Provider(provider: EIP1193Provider): boolean {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(provider, "request");
      if (descriptor && (descriptor.writable === false || (descriptor.get && !descriptor.set))) {
        return false;
      }
    } catch {
      return false;
    }
    return typeof provider.request === "function";
  }

  /**
   * Attempts to detect information about an injected provider
   * @param provider The injected provider to analyze
   * @returns Provider information with fallback values
   */
  private detectInjectedProviderInfo(provider: EIP1193Provider): {
    name: string;
    rdns: string;
    uuid: string;
    icon: `data:image/${string}`;
  } {
    // Try to detect provider type from common properties
    let name = 'Injected Provider';
    let rdns = 'io.injected.provider';
    
    // Check if it's MetaMask
    if ((provider as any).isMetaMask) {
      name = 'MetaMask';
      rdns = 'io.metamask';
    }
    // Check if it's Coinbase Wallet
    else if ((provider as any).isCoinbaseWallet) {
      name = 'Coinbase Wallet';
      rdns = 'com.coinbase.wallet';
    }
    // Check if it's WalletConnect
    else if ((provider as any).isWalletConnect) {
      name = 'WalletConnect';
      rdns = 'com.walletconnect';
    }
    // Check if it's Trust Wallet
    else if ((provider as any).isTrust) {
      name = 'Trust Wallet';
      rdns = 'com.trustwallet';
    }
    // Check if it's Brave Wallet
    else if ((provider as any).isBraveWallet) {
      name = 'Brave Wallet';
      rdns = 'com.brave.wallet';
    }
    // Check if it's Phantom
    else if ((provider as any).isPhantom) {
      name = 'Phantom';
      rdns = 'app.phantom';
    }
    
    return {
      name,
      rdns,
      uuid: `injected-${rdns.replace(/[^a-zA-Z0-9]/g, '-')}`,
      icon: DEFAULT_PROVIDER_ICON
    };
  }

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
        // Detect newly discovered wallets (session de-dupes)
        this.detectWallets(newDetails);
      }
    });

    // Fallback to injected provider if no providers are found
    if (providers.length === 0) {
      const injected = typeof window !== 'undefined' ? window.ethereum : undefined;
      if (injected && !this._trackedProviders.has(injected)) {
        this.trackProvider(injected);
        // Create a mock EIP6963ProviderDetail for the injected provider
        const injectedProviderInfo = this.detectInjectedProviderInfo(injected);
        const injectedDetail: EIP6963ProviderDetail = {
          provider: injected,
          info: injectedProviderInfo
        };
        this._providers = [injectedDetail];
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
        return this.validateAndChecksumAddress(accounts[0]) || null;
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
        .map((e) => this.validateAndChecksumAddress(e))
        .filter((e): e is string => e !== undefined);
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
    
    const validAddress = this.validateAndChecksumAddress(rawAddress);
    if (!validAddress) {
      throw new Error(`Invalid address in signature payload: ${rawAddress}`);
    }
    
    const basePayload = {
      chainId: chainId ?? this.currentChainId ?? 0,
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
    
    const validAddress = this.validateAndChecksumAddress(from);
    if (!validAddress) {
      throw new Error(`Invalid address in transaction payload: ${from}`);
    }
    
    return {
      chainId: this.currentChainId ?? (await this.getCurrentChainId(provider)),
      data,
      address: validAddress,
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

  // Explicitly untrack a provider: remove listeners, clear wrapper flag and tracking
  private untrackProvider(provider: EIP1193Provider): void {
    try {
      this.removeProviderListeners(provider);
      this._trackedProviders.delete(provider);
      this.invalidateProviderOperationTokens(provider);
      if (this._provider === provider) {
        this._provider = undefined;
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
   * Helper method to validate and checksum an address
   * @param address The address to validate and checksum
   * @returns The checksummed address or undefined if invalid
   */
  private validateAndChecksumAddress(address: string): Address | undefined {
    const validAddress = getValidAddress(address);
    return validAddress ? toChecksumAddress(validAddress) : undefined;
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
