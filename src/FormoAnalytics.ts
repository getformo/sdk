import { UUID } from "crypto";
import { createStore, EIP6963ProviderDetail } from "mipd";
import {
  Event,
  EVENTS_API_URL,
  LOCAL_ANONYMOUS_ID_KEY,
  SESSION_CURRENT_URL_KEY,
  SESSION_USER_ID_KEY,
  SESSION_WALLET_DETECTED_KEY,
} from "./constants";
import {
  EventFactory,
  EventQueue,
  IEventFactory,
  local,
  logger,
  Logger,
  session,
} from "./lib";
import {
  Address,
  ChainID,
  Config,
  EIP1193Provider,
  Options,
  RequestArguments,
  RPCError,
  SignatureStatus,
  TransactionStatus,
} from "./types";
import { generateNativeUUID, toSnake, toSnakeCase } from "./utils";
import { isAddress, isArray, isLocalhost } from "./validators";

interface IFormoAnalytics {
  page(): void;
  reset(): void;
  connect(params: { chainId: ChainID; address: Address }): Promise<void>;
  disconnect(params?: { chainId?: ChainID; address?: Address }): Promise<void>;
  chain(params: { chainId: ChainID; address?: Address }): Promise<void>;
  signature(params: {
    status: SignatureStatus;
    chainId?: ChainID;
    address: Address;
    message: string;
    signatureHash?: string;
  }): Promise<void>;
  transaction(params: {
    status: TransactionStatus;
    chainId: ChainID;
    address: Address;
    data?: string;
    to?: string;
    value?: string;
    transactionHash?: string;
  }): Promise<void>;
  identify(
    params?:
      | {
          address: Address | null;
          providerName?: string;
          userId?: string;
          rdns?: string;
        }
      | readonly EIP6963ProviderDetail[]
  ): Promise<void>;
  track(action: string, payload: Record<string, any>): Promise<void>;
}

export class FormoAnalytics implements IFormoAnalytics {
  private _provider?: EIP1193Provider;
  private _providerListeners: Record<string, (...args: unknown[]) => void> = {};
  private session: FormoAnalyticsSession;
  private eventQueue: EventQueue;
  private anonymousId: UUID | null = null;
  private userId: string | null = null;
  private eventFactory: IEventFactory;

  config: Config;
  currentChainId?: ChainID;
  currentConnectedAddress?: Address;

  private constructor(
    public readonly writeKey: string,
    public options: Options = {}
  ) {
    this.config = {
      writeKey,
      trackLocalhost: options.trackLocalhost || false,
    };

    this.session = new FormoAnalyticsSession();

    // Initialize logger with configuration from options
    Logger.init({
      enabled: options.logger?.enabled || false,
      enabledLevels: options.logger?.levels || [],
    });

    this.eventFactory = new EventFactory();

    this.eventQueue = new EventQueue(this.config.writeKey, {
      url: EVENTS_API_URL,
      flushAt: options.flushAt,
      retryCount: options.retryCount,
      maxQueueSize: options.maxQueueSize,
      flushInterval: options.flushInterval,
    });

    this.anonymousId = this.getAnonymousId();
    this.userId = session.get(SESSION_USER_ID_KEY) as string | null;

    // TODO: replace with eip6963
    const provider = options.provider || window?.ethereum;
    if (provider) {
      this.trackProvider(provider);
    }

    this.trackFirstPageHit();
    this.trackPageHits();
  }

  static async init(
    writeKey: string,
    options?: Options
  ): Promise<FormoAnalytics> {
    const analytics = new FormoAnalytics(writeKey, options);

    // Detect
    const providers = await analytics.getProviders();
    await analytics.detects(providers);

    return analytics;
  }

  /*
    Public SDK functions
  */

  /**
   * Emits a page visit event with the current URL information, fire on page change.
   * @returns {Promise<void>}
   */
  public async page(): Promise<void> {
    await this.trackPageHit();
  }

  /**
   * Reset the current user session.
   * @returns {void}
   */
  public reset(): void {
    this.anonymousId = this.getAnonymousId();
    this.userId = null;
    local.remove(LOCAL_ANONYMOUS_ID_KEY);
    session.remove(SESSION_USER_ID_KEY);
  }

  /**
   * Emits a wallet connect event.
   * @param {ChainID} params.chainId
   * @param {Address} params.address
   * @throws {Error} If chainId or address is empty
   * @returns {Promise<void>}
   */
  async connect({
    chainId,
    address,
  }: {
    chainId: ChainID;
    address: Address;
  }): Promise<void> {
    if (!chainId) {
      logger.warn("Connect: Chain ID cannot be empty");
    }
    if (!address) {
      logger.warn("Connect: Address cannot be empty");
    }

    this.currentChainId = chainId;
    this.currentConnectedAddress = address;

    await this.trackEvent(Event.CONNECT, {
      chainId,
      address,
    });
  }

  /**
   * Emits a wallet disconnect event.
   * @param {ChainID} params.chainId
   * @param {Address} params.address
   * @returns {Promise<void>}
   */
  async disconnect(params?: {
    chainId?: ChainID;
    address?: Address;
  }): Promise<void> {
    const address = params?.address || this.currentConnectedAddress;
    const chainId = params?.chainId || this.currentChainId;

    await this.handleDisconnect(chainId, address);
  }

  /**
   * Emits a chain network change event.
   * @param {ChainID} params.chainId
   * @param {Address} params.address
   * @throws {Error} If chainId is empty, zero, or not a valid number
   * @throws {Error} If no address is provided and no previous address is recorded
   * @returns {Promise<void>}
   */
  async chain({
    chainId,
    address,
  }: {
    chainId: ChainID;
    address?: Address;
  }): Promise<void> {
    if (!chainId || Number(chainId) === 0) {
      throw new Error("FormoAnalytics::chain: chainId cannot be empty or 0");
    }
    if (isNaN(Number(chainId))) {
      throw new Error(
        "FormoAnalytics::chain: chainId must be a valid decimal number"
      );
    }
    if (!address && !this.currentConnectedAddress) {
      throw new Error(
        "FormoAnalytics::chain: address was empty and no previous address has been recorded"
      );
    }

    this.currentChainId = chainId;

    await this.trackEvent(Event.CHAIN_CHANGED, {
      chainId,
      address: address || this.currentConnectedAddress,
    });
  }

  /**
   * Emits a signature event.
   * @param {SignatureStatus} params.status - requested, confirmed, rejected
   * @param {ChainID} params.chainId
   * @param {Address} params.address
   * @param {string} params.message
   * @param {string} params.signatureHash - only provided if status is confirmed
   * @returns {Promise<void>}
   */
  async signature({
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
  }): Promise<void> {
    await this.trackEvent(Event.SIGNATURE, {
      status,
      chainId,
      address,
      message,
      ...(signatureHash && { signatureHash }),
    });
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
   * @returns {Promise<void>}
   */
  async transaction({
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
  }): Promise<void> {
    await this.trackEvent(Event.TRANSACTION, {
      status,
      chainId,
      address,
      data,
      to,
      value,
      ...(transactionHash && { transactionHash }),
    });
  }

  /**
   * Emits an detect event with current wallet provider info.
   * @param {string} params.providerName
   * @param {string} params.rdns
   * @param {string} params.userId
   * @param {string} params.address
   *
   * @returns {Promise<void>}
   */
  public async identify(
    params?:
      | {
          address: Address | null;
          providerName?: string;
          userId?: string;
          rdns?: string;
        }
      | readonly EIP6963ProviderDetail[]
  ): Promise<void> {
    if (isArray(params) || !params) {
      const providers = isArray(params) ? params : await this.getProviders();
      try {
        for (const eip6963ProviderDetail of providers) {
          if (!eip6963ProviderDetail) continue;
          const accounts = await this.getAccounts(
            eip6963ProviderDetail?.provider
          );
          // Identify with accounts
          if (accounts && accounts.length > 0) {
            for (const address of accounts) {
              await this.identify({
                address,
                providerName: eip6963ProviderDetail?.info.name,
                rdns: eip6963ProviderDetail?.info.rdns,
              });
            }
          }
        }
      } catch (err) {
        logger.error("Error identifying all:", err);
      }
    } else {
      const { userId, address, providerName, rdns } = params as {
        address: Address | null;
        providerName?: string;
        userId?: string;
        rdns?: string;
      };
      if (userId) this.userId = userId || null;
      await this.trackEvent(Event.IDENTIFY, {
        address,
        providerName,
        rdns,
      });
    }
  }

  /**
   * Emits an identify event with current wallet address.
   * @param {Address} params.address
   * @returns {Promise<void>}
   */
  private async detect({
    providerName,
    rdns,
  }: {
    providerName: string;
    rdns: string;
  }): Promise<void> {
    if (this.session.isWalletDetected(rdns))
      return logger.warn(
        `detect: Wallet ${providerName} already detected in this session`
      );

    this.session.markWalletdetected(rdns);
    await this.trackEvent(Event.DETECT_WALLET, {
      providerName,
      rdns,
    });
  }

  /**
   * Emits a custom event with custom data.
   * @param {string} action
   * @param {Record<string, any>} payload
   * @returns {Promise<void>}
   */
  async track(action: string, payload: Record<string, any>): Promise<void> {
    await this.trackEvent(toSnake(action), toSnakeCase(payload));
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
      this.currentConnectedAddress = undefined;

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
      this.registerAddressChangedListener();
      this.registerChainChangedListener();
      this.registerSignatureListener();
      this.registerTransactionListener();
    } catch (error) {
      logger.error("Error tracking provider:", error);
    }
  }

  private registerAddressChangedListener(): void {
    const listener = (...args: unknown[]) =>
      this.onAddressChanged(args[0] as string[]);

    this._provider?.on("accountsChanged", listener);
    this._providerListeners["accountsChanged"] = listener;

    const onAddressDisconnected = this.onAddressDisconnected.bind(this);
    this._provider?.on("disconnect", onAddressDisconnected);
    this._providerListeners["disconnect"] = onAddressDisconnected;
  }

  private registerChainChangedListener(): void {
    const listener = (...args: unknown[]) =>
      this.onChainChanged(args[0] as string);
    this.provider?.on("chainChanged", listener);
    this._providerListeners["chainChanged"] = listener;
  }

  private registerSignatureListener(): void {
    if (!this.provider) {
      logger.error("Provider not found for signature tracking");
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
      if (
        Array.isArray(params) &&
        ["eth_signTypedData_v4", "personal_sign"].includes(method)
      ) {
        // Emit signature request event
        this.signature({
          status: SignatureStatus.REQUESTED,
          ...this.buildSignatureEventPayload(method, params),
        });

        try {
          const response = (await request({ method, params })) as T;
          if (response) {
            // Emit signature confirmed event
            this.signature({
              status: SignatureStatus.CONFIRMED,
              ...this.buildSignatureEventPayload(method, params, response),
            });
          }
          return response;
        } catch (error) {
          const rpcError = error as RPCError;
          if (rpcError && rpcError?.code === 4001) {
            // Emit signature rejected event
            this.signature({
              status: SignatureStatus.REJECTED,
              ...this.buildSignatureEventPayload(method, params),
            });
          }
          throw error;
        }
      }
      return request({ method, params });
    };
    return;
  }

  private registerTransactionListener(): void {
    if (!this.provider) {
      logger.error("Provider not found for transaction tracking");
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
      if (
        Array.isArray(params) &&
        method === "eth_sendTransaction" &&
        params[0]
      ) {
        // Track transaction start
        const payload = await this.buildTransactionEventPayload(params);
        this.transaction({ status: TransactionStatus.STARTED, ...payload });

        try {
          // Wait for the transaction hash
          const transactionHash = (await request({ method, params })) as string;

          // Track transaction broadcast
          this.transaction({
            status: TransactionStatus.BROADCASTED,
            ...payload,
            transactionHash,
          });

          return;
        } catch (error) {
          logger.error("Transaction error:", error);
          const rpcError = error as RPCError;
          if (rpcError && rpcError?.code === 4001) {
            // Emit transaction rejected event
            this.transaction({
              status: TransactionStatus.REJECTED,
              ...payload,
            });
          }
          throw error;
        }
      }

      return request({ method, params });
    };

    return;
  }

  private async onAddressChanged(addresses: Address[]): Promise<void> {
    if (addresses.length > 0) {
      this.onAddressConnected(addresses[0]);
    } else {
      this.onAddressDisconnected();
    }
  }

  private async onAddressConnected(address: Address): Promise<void> {
    if (address === this.currentConnectedAddress)
      // We have already reported this address
      return;

    this.currentConnectedAddress = address;

    this.currentChainId = await this.getCurrentChainId();
    this.connect({ chainId: this.currentChainId, address });
  }

  private async handleDisconnect(
    chainId?: ChainID,
    address?: Address
  ): Promise<void> {
    const payload = {
      chain_id: chainId || this.currentChainId,
      address: address || this.currentConnectedAddress,
    };
    this.currentChainId = undefined;
    this.currentConnectedAddress = undefined;
    session.remove(SESSION_USER_ID_KEY);

    await this.trackEvent(Event.DISCONNECT, payload);
  }

  private async onAddressDisconnected(): Promise<void> {
    await this.handleDisconnect(
      this.currentChainId,
      this.currentConnectedAddress
    );
  }

  private async onChainChanged(chainIdHex: string): Promise<void> {
    this.currentChainId = parseInt(chainIdHex);
    if (!this.currentConnectedAddress) {
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
      this.currentConnectedAddress = address;
    }

    // Proceed only if the address exists
    if (this.currentConnectedAddress) {
      return this.chain({
        chainId: this.currentChainId,
        address: this.currentConnectedAddress,
      });
    } else {
      logger.info(
        "OnChainChanged: Current connected address is null despite fetch attempt"
      );
    }
  }

  private async trackFirstPageHit(): Promise<void> {
    if (session.get(SESSION_CURRENT_URL_KEY) === null) {
      session.set(SESSION_CURRENT_URL_KEY, window.location.href);
    }

    return this.trackPageHit();
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

  private async onLocationChange(): Promise<void> {
    const currentUrl = session.get(SESSION_CURRENT_URL_KEY);

    if (currentUrl !== window.location.href) {
      session.set(SESSION_CURRENT_URL_KEY, window.location.href);
      this.trackPageHit();
    }
  }

  private trackPageHit(): void {
    if (!this.config.trackLocalhost && isLocalhost()) {
      return logger.warn(
        "Track page hit: Ignoring event because website is running locally"
      );
    }

    setTimeout(async () => {
      this.trackEvent(Event.PAGE);
    }, 300);
  }

  private async trackEvent(action: string, payload?: any): Promise<void> {
    try {
      const address = await this.getAddress();
      const user_id = this.userId;

      const requestData = this.eventFactory.create(
        this.anonymousId as UUID,
        user_id,
        address,
        {
          action,
          ...payload,
        }
      );

      await this.eventQueue.enqueue(requestData, (err, _, data) => {
        if (err) {
          logger.error("Error sending events:", err);
        } else logger.info(`Events sent successfully: ${data.length} events`);
      });
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
    // TODO: consider using store.subscribe to detect changes to providers list
    store.subscribe((providerDetails) => (providers = providerDetails));

    // Fallback to injected provider if no providers are found
    if (providers.length === 0) {
      return window?.ethereum ? [window.ethereum] : [];
    }
    return providers;
  }

  private async detects(
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

  private getAnonymousId(): UUID {
    const storedAnonymousId = local.get(LOCAL_ANONYMOUS_ID_KEY);
    if (storedAnonymousId && typeof storedAnonymousId === "string")
      return storedAnonymousId as UUID;
    const newAnonymousId = generateNativeUUID();
    local.set(LOCAL_ANONYMOUS_ID_KEY, newAnonymousId);
    return newAnonymousId;
  }

  private async getAddress(): Promise<Address | null> {
    if (this.currentConnectedAddress) return this.currentConnectedAddress;
    if (!this?.provider) {
      logger.info("The provider is not set");
      return null;
    }

    try {
      const accounts = await this.getAccounts();
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
      return parseInt(chainIdHex as string, 16);
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
}

interface IFormoAnalyticsSession {
  isWalletDetected(rdns: string): boolean;
  markWalletdetected(rdns: string): void;
}

class FormoAnalyticsSession implements IFormoAnalyticsSession {
  constructor() {}

  public isWalletDetected(rdns: string): boolean {
    const rdnses = (session.get(SESSION_WALLET_DETECTED_KEY) as string[]) || [];
    return rdnses.includes(rdns);
  }

  public markWalletdetected(rdns: string): void {
    const rdnses = (session.get(SESSION_WALLET_DETECTED_KEY) as string[]) || [];
    rdnses.push(rdns);
    session.set(SESSION_WALLET_DETECTED_KEY, rdnses);
  }
}
