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
  TransactionStatus,
  ConnectInfo,
} from "./types";
import { isAddress, isLocalhost } from "./validators";
import { parseChainId } from "./utils/chain";

export class FormoAnalytics implements IFormoAnalytics {
  private _provider?: EIP1193Provider;
  private _providerListeners: Record<string, (...args: unknown[]) => void> = {};
  private session: FormoAnalyticsSession;
  private eventManager: IEventManager;
  private _providers: readonly EIP6963ProviderDetail[] = [];

  config: Config;
  currentChainId?: ChainID;
  currentAddress?: Address = "";
  currentUserId?: string = "";

  private constructor(
    public readonly writeKey: string,
    public options: Options = {}
  ) {
    this.config = {
      writeKey,
      trackLocalhost: options.trackLocalhost || false,
    };

    this.session = new FormoAnalyticsSession();
    this.currentUserId =
      (cookie().get(SESSION_USER_ID_KEY) as string) || undefined;

    this.identify = this.identify.bind(this);
    this.connect = this.connect.bind(this);
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

    // TODO: replace with eip6963
    const provider = options.provider || window?.ethereum;
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
   * @returns {Promise<void>}
   */
  public async page(
    category?: string,
    name?: string,
    properties?: IFormoEventProperties,
    context?: IFormoEventContext
  ): Promise<void> {
    await this.trackPageHit(category, name, properties, context);
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
    this.currentAddress = address;

    await this.trackEvent(
      EventType.CONNECT,
      {
        chainId,
        address,
      },
      properties,
      context,
      callback
    );
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
      logger.debug("Identify", address, userId, providerName, rdns);
      if (address) this.currentAddress = address;
      if (userId) {
        this.currentUserId = userId;
        cookie().set(SESSION_USER_ID_KEY, userId);
      }

      await this.trackEvent(
        EventType.IDENTIFY,
        {
          address,
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
    try {
      if (provider === this._provider) {
        logger.warn("TrackProvider: Provider already tracked.");
        return;
      }

      this.currentChainId = undefined;
      this.currentAddress = undefined;

      if (this._provider) {
        const actions = Object.keys(this._providerListeners);
        for (const action of actions) {
          this._provider.removeListener(
            action,
            this._providerListeners[action]
          );
          delete this._providerListeners[action];
        }
      }

      this._provider = provider;

      // Register listeners for web3 provider events
      this.registerAccountsChangedListener();
      this.registerChainChangedListener();
      this.registerConnectListener();
      this.registerRequestListeners();
    } catch (error) {
      logger.error("Error tracking provider:", error);
    }
  }

  private registerAccountsChangedListener(): void {
    const listener = (...args: unknown[]) =>
      this.onAccountsChanged(args[0] as string[]);

    this._provider?.on("accountsChanged", listener);
    this._providerListeners["accountsChanged"] = listener;
  }

  private async onAccountsChanged(addresses: Address[]): Promise<void> {
    if (addresses.length > 0) {
      const address = addresses[0];
      if (address === this.currentAddress) {
        // We have already reported this address
        return;
      }
      this.currentAddress = address;
      this.currentChainId = await this.getCurrentChainId();
      this.connect({ chainId: this.currentChainId, address });
    }
  }

  private registerChainChangedListener(): void {
    const listener = (...args: unknown[]) =>
      this.onChainChanged(args[0] as string);
    this.provider?.on("chainChanged", listener);
    this._providerListeners["chainChanged"] = listener;
  }

  private async onChainChanged(chainIdHex: string): Promise<void> {
    this.currentChainId = parseChainId(chainIdHex);
    if (!this.currentAddress) {
      if (!this.provider) {
        logger.info(
          "OnChainChanged: Provider not found. CHAIN_CHANGED not reported"
        );
        return Promise.resolve();
      }

      const address = await this.getAddress();
      if (!address) {
        logger.info(
          "OnChainChanged: Unable to fetch or store connected address"
        );
        return Promise.resolve();
      }
      this.currentAddress = address;
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

  private registerConnectListener(): void {
    const listener = (...args: unknown[]) => {
      const connection: ConnectInfo = args[0] as ConnectInfo;
      this.onConnected(connection);
    };
    this._provider?.on("connect", listener);
    this._providerListeners["connect"] = listener;
  }

  private async onConnected(connection: ConnectInfo): Promise<void> {
    try {
      if (!connection || typeof connection.chainId !== 'string') return;
      const chainId = parseChainId(connection.chainId);
      const address = await this.getAddress();
      if (chainId && address) {
        this.connect({ chainId, address });
      }
    } catch (e) {
      logger.error("Error handling connect event", e);
    }
  }

  private registerRequestListeners(): void {
    logger.debug("registerRequestListeners");
    if (!this.provider) {
      logger.error("Provider not found for request (signature, transaction) tracking");
      return;
    }
    if (
      Object.getOwnPropertyDescriptor(this.provider, "request")?.writable ===
      false
    ) {
      logger.warn("Provider.request is not writable");
      return;
    }

    const request = this.provider.request.bind(this.provider);

    this.provider.request = async <T>({
      method,
      params,
    }: RequestArguments): Promise<T | null | undefined> => {
      // Handle Signatures
      if (
        Array.isArray(params) &&
        ["eth_signTypedData_v4", "personal_sign"].includes(method)
      ) {
        // Fire-and-forget tracking
        (async () => {
          try {
            this.signature({
              status: SignatureStatus.REQUESTED,
              ...this.buildSignatureEventPayload(method, params),
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
                  ...this.buildSignatureEventPayload(method, params, response),
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
                  ...this.buildSignatureEventPayload(method, params),
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
            const payload = await this.buildTransactionEventPayload(params);
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
              const payload = await this.buildTransactionEventPayload(params);
              this.transaction({
                status: TransactionStatus.BROADCASTED,
                ...payload,
                transactionHash,
              });

              // Start async polling for transaction receipt
              this.pollTransactionReceipt(transactionHash, payload);
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
                  params
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
    if (!this.config.trackLocalhost && isLocalhost()) {
      return logger.warn(
        "Track page hit: Ignoring event because website is running locally"
      );
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

  /*
    Utility functions
  */

  private async getProviders(): Promise<readonly EIP6963ProviderDetail[]> {
    const store = createStore();
    let providers = store.getProviders();
    store.subscribe((providerDetails) => {
      providers = providerDetails;
      this._providers = providers;
    });

    // Fallback to injected provider if no providers are found
    if (providers.length === 0) {
      this._providers = window?.ethereum ? [window.ethereum] : [];
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
        if (isAddress(accounts[0])) {
          return accounts[0];
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
      return res.filter((e) => isAddress(e));
    } catch (err) {
      if ((err as any).code !== 4001) {
        logger.error(
          "FormoAnalytics::getAccounts: eth_accounts threw an error",
          err
        );
      }
      return null;
    }
  }

  private async getCurrentChainId(): Promise<number> {
    if (!this.provider) {
      logger.error("Provider not set for chain ID");
    }

    let chainIdHex;
    try {
      chainIdHex = await this.provider?.request<string>({
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
    response?: unknown
  ) {
    const basePayload = {
      chainId: this.currentChainId,
      address:
        method === "personal_sign"
          ? (params[1] as Address)
          : (params[0] as Address),
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

  private async buildTransactionEventPayload(params: unknown[]) {
    const { data, from, to, value } = params[0] as {
      data: string;
      from: string;
      to: string;
      value: string;
    };
    return {
      chainId: this.currentChainId || (await this.getCurrentChainId()),
      data,
      address: from,
      to,
      value,
    };
  }

  /**
   * Polls for transaction receipt and emits tx.status = CONFIRMED or REVERTED.
   */
  private async pollTransactionReceipt(
    transactionHash: string,
    payload: any,
    maxAttempts = 10,
    intervalMs = 3000
  ) {
    let attempts = 0;
    const provider = this.provider;
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
