import axios from "axios";
import { createStore, EIP6963ProviderDetail } from "mipd";
import {
  COUNTRY_LIST,
  CURRENT_URL_KEY,
  EVENTS_API_URL,
  Event,
} from "./constants";
import {
  ChainID,
  Address,
  EIP1193Provider,
  Options,
  Config,
  RequestArguments,
  RPCError,
  SignatureStatus,
  TransactionStatus,
} from "./types";
import { toSnakeCase } from "./lib/utils";

interface IFormoAnalytics {
  page(): void;
  connect(params: { chainId: ChainID; address: Address }): Promise<void>;
  disconnect(params?: { chainId?: ChainID; address?: Address }): Promise<void>;
  chain(params: { chainId: ChainID; address?: Address }): Promise<void>;
  signature({
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
  }): Promise<void>;
  transaction({
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
  }): Promise<void>;
  identify(params: { address: Address }): Promise<void>;
  track(action: string, payload: Record<string, any>): Promise<void>;
}

export class FormoAnalytics implements IFormoAnalytics {
  private _provider?: EIP1193Provider;
  private _providerListeners: Record<string, (...args: unknown[]) => void> = {};

  config: Config;
  currentChainId?: ChainID;
  currentConnectedAddress?: Address;

  private constructor(
    public readonly apiKey: string,
    public options: Options = {}
  ) {
    this.config = {
      apiKey: apiKey,
    };

    // TODO: replace with eip6963
    const provider = options.provider || window?.ethereum;
    if (provider) {
      this.trackProvider(provider);
    }

    this.trackFirstPageHit();
    this.trackPageHits();
  }

  static async init(
    apiKey: string,
    options?: Options
  ): Promise<FormoAnalytics> {
    const analytics = new FormoAnalytics(apiKey, options);

    // Identify
    const providers = await analytics.getProviders();
    await analytics.identifyAll(providers);

    return analytics;
  }

  /*
    Public SDK functions
  */

  /**
   * Emits a page visit event with the current URL information, fire on page change.
   * @returns {Promise<void>}
   */
  async page(): Promise<void> {
    await this.trackPageHit();
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
      throw new Error("FormoAnalytics::connect: chain ID cannot be empty");
    }
    if (!address) {
      throw new Error("FormoAnalytics::connect: address cannot be empty");
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
   * Emits a identify event with current wallet address.
   * @param {Address} params.address
   * @returns {Promise<void>}
   */
  public async identify({
    address,
    providerName,
    rdns,
  }: {
    address: Address;
    providerName?: string;
    rdns?: string;
  }): Promise<void> {
    if (address) {
      await this.trackEvent(Event.IDENTIFY, {
        address,
        providerName,
        rdns,
      });
    }
  }

  /**
   * Emits a custom event with custom data.
   * @param {string} action
   * @param {Record<string, any>} payload
   * @returns {Promise<void>}
   */
  async track(action: string, payload: Record<string, any>): Promise<void> {
    await this.trackEvent(action, payload);
  }

  /*
    SDK tracking and event listener functions
  */

  private trackProvider(provider: EIP1193Provider): void {
    if (provider === this._provider) {
      console.log("Provider already tracked.");
      return;
    }

    this.currentChainId = undefined;
    this.currentConnectedAddress = undefined;

    if (this._provider) {
      const actions = Object.keys(this._providerListeners);
      for (const action of actions) {
        this._provider.removeListener(action, this._providerListeners[action]);
        delete this._providerListeners[action];
      }
    }

    this._provider = provider;

    // Register listeners for web3 provider events
    this.registerAddressChangedListener();
    this.registerChainChangedListener();
    this.registerSignatureListener();
    this.registerTransactionListener();
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
      console.error("_trackSigning: provider not found");
      return;
    }
    if (
      Object.getOwnPropertyDescriptor(this.provider, "request")?.writable ===
      false
    ) {
      console.warn("_trackSigning: provider.request is not writable");
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
      console.error("_trackTransactions: provider not found");
      return;
    }
    if (
      Object.getOwnPropertyDescriptor(this.provider, "request")?.writable ===
      false
    ) {
      console.warn("_trackTransactions: provider.request is not writable");
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
          console.log("transaction listener catch");
          console.log(error);
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
    if (address === this.currentConnectedAddress) {
      // We have already reported this address
      return;
    } else {
      this.currentConnectedAddress = address;
    }

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
        console.log(
          "FormoAnalytics::onChainChanged: provider not found. CHAIN_CHANGED not reported"
        );
        return Promise.resolve();
      }

      const address = await this.getAddress();
      if (!address) {
        console.log(
          "FormoAnalytics::onChainChanged: Unable to fetch or store connected address"
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
      console.log(
        "FormoAnalytics::onChainChanged: currentConnectedAddress is null despite fetch attempt"
      );
    }
  }

  private async trackFirstPageHit(): Promise<void> {
    if (sessionStorage.getItem(CURRENT_URL_KEY) === null) {
      sessionStorage.setItem(CURRENT_URL_KEY, window.location.href);
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
    const currentUrl = sessionStorage.getItem(CURRENT_URL_KEY);

    if (currentUrl !== window.location.href) {
      sessionStorage.setItem(CURRENT_URL_KEY, window.location.href);
      this.trackPageHit();
    }
  }

  private trackPageHit(): void {
    const pathname = window.location.pathname;
    const href = window.location.href;
    const hash = window.location.hash;

    setTimeout(async () => {
      this.trackEvent(Event.PAGE, {
        pathname,
        href,
        hash,
      });
    }, 300);
  }

  // TODO: refactor this with event queue and flushing
  // https://linear.app/getformo/issue/P-835/sdk-refactor-retries-with-event-queue-and-batching
  private async trackEvent(action: string, payload: any): Promise<void> {
    const address = await this.getAddress();

    const requestData = {
      address,
      timestamp: new Date().toISOString(),
      action,
      version: "1",
      payload: await this.buildEventPayload(toSnakeCase(payload)),
    };

    try {
      const response = await axios.post(
        EVENTS_API_URL,
        JSON.stringify(requestData),
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.config.apiKey}`,
          },
        }
      );

      if (response.status >= 200 && response.status < 300) {
        console.log(
          `Event sent successfully: ${this.getActionDescriptor(
            action,
            payload
          )}`
        );
      } else {
        throw new Error(`Failed with status: ${response.status}`);
      }
    } catch (error) {
      console.error(`Event "${action}" failed. Error: ${error}`);
    }
  }

  /*
    Utility functions
  */

  private async getProviders(): Promise<EIP6963ProviderDetail[]> {
    const store = createStore();
    const providers = [...store.getProviders()];
    // TODO: consider using store.subscribe to detect changes to providers list
    // store.subscribe(providers => (state.providers = providers))

    // Fallback to injected provider if no providers are found
    if (providers.length === 0) {
      return [window?.ethereum];
    }
    return providers;
  }

  private async identifyAll(providers: EIP6963ProviderDetail[]): Promise<void> {
    for (const { provider, info } of providers) {
      try {
        const accounts = await this.getAccounts(provider);
        if (accounts && accounts.length > 0) {
          for (const address of accounts) {
            await this.identify({
              address,
              providerName: info.name,
              rdns: info.rdns,
            });
          }
        }
      } catch (err) {}
    }
  }

  get provider(): EIP1193Provider | undefined {
    return this._provider;
  }

  private async getAddress(): Promise<Address | null> {
    if (this.currentConnectedAddress) return this.currentConnectedAddress;
    if (!this.provider) {
      console.log("FormoAnalytics::getAddress: the provider is not set");
      return null;
    }

    try {
      const accounts = await this.getAccounts();
      if (accounts && accounts.length > 0) {
        return accounts[0];
      }
    } catch (err) {
      console.log("Failed to fetch accounts from provider:", err);
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
      return res;
    } catch (err) {
      if ((err as any).code !== 4001) {
        console.log(
          "FormoAnalytics::getAccounts: eth_accounts threw an error",
          err
        );
      }
      return null;
    }
  }

  private async getCurrentChainId(): Promise<number> {
    if (!this.provider) {
      console.error("FormoAnalytics::getCurrentChainId: provider not set");
    }

    let chainIdHex;
    try {
      chainIdHex = await this.provider?.request<string>({
        method: "eth_chainId",
      });
      if (!chainIdHex) {
        console.log("FormoAnalytics::fetchChainId: chain id not found");
        return 0;
      }
      return parseInt(chainIdHex as string, 16);
    } catch (err) {
      console.log(
        "FormoAnalytics::fetchChainId: eth_chainId threw an error",
        err
      );
      return 0;
    }
  }

  private getLocation(): string | undefined {
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (timezone in COUNTRY_LIST)
        return COUNTRY_LIST[timezone as keyof typeof COUNTRY_LIST];
      return timezone;
    } catch (error) {
      console.error("Error resolving timezone:", error);
      return "";
    }
  }

  private getLanguage(): string {
    try {
      return (
        (navigator.languages && navigator.languages.length
          ? navigator.languages[0]
          : navigator.language) || "en"
      );
    } catch (error) {
      console.error("Error resolving language:", error);
      return "en";
    }
  }

  // Adds browser properties to the user-supplied payload
  private async buildEventPayload(
    eventSpecificPayload: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>> {
    const url = new URL(window.location.href);
    const params = new URLSearchParams(url.search);

    const location = this.getLocation();
    const language = this.getLanguage();

    // common browser properties
    return {
      "user-agent": window.navigator.userAgent,
      locale: language,
      location,
      referrer: document.referrer,
      utm_source: params.get("utm_source"),
      utm_medium: params.get("utm_medium"),
      utm_campaign: params.get("utm_campaign"),
      ref: params.get("ref"),
      ...eventSpecificPayload,
    };
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

  private getActionDescriptor(action: string, payload: any): string {
    return `${action}${payload.status ? ` ${payload.status}` : ""}`;
  }
}
