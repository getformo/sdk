import axios from "axios";
import {
  COUNTRY_LIST,
  EVENTS_API_URL,
  Event,
} from "./constants";
import { H } from "highlight.run";
import { ChainID, Address, EIP1193Provider, Options, Config, RequestArguments } from "./types";

interface IFormoAnalytics {
  page(): void;
  connect(params: { chainId: ChainID; address: Address }): Promise<void>;
  disconnect(params?: { chainId?: ChainID; address?: Address }): Promise<void>;
  chain(params: { chainId: ChainID; address?: Address }): Promise<void>;
  signatureStarted(params: { address: Address, message: string }): Promise<void>;
  signatureCompleted(params: { address: Address, signatureHash: string, message: string }): Promise<void>;
  transaction(params: { chainId: ChainID, transactionHash: string }): Promise<void>;  
  track(action: string, payload: Record<string, any>): Promise<void>;
}

export class FormoAnalytics implements IFormoAnalytics {
  private _provider?: EIP1193Provider;
  private _providerListeners: Record<
    string,
    (...args: unknown[]) => void
  > = {};

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
    const provider =
      window?.ethereum || window.web3?.currentProvider || options?.provider;
    if (provider) {
      this.trackProvider(provider);
    }
  }

  static async init(
    apiKey: string,
    options?: Options
  ): Promise<FormoAnalytics> {
    // May be needed for delayed loading
    // https://github.com/segmentio/analytics-next/tree/master/packages/browser#lazy--delayed-loading
    return new FormoAnalytics(apiKey, options);
  }

  /*
    Public SDK functions
  */

  /**
   * Emits a page visit event with the current URL information.
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
  async connect({ chainId, address }: { chainId: ChainID; address: Address }): Promise<void> {
    if (!chainId) {
      throw new Error("FormoAnalytics::connect: chain ID cannot be empty");
    }
    if (!address) {
      throw new Error("FormoAnalytics::connect: address cannot be empty");
    }

    this.currentChainId = chainId;
    this.currentConnectedAddress = address;

    await this.trackEvent(Event.CONNECT, {
      chain_id: chainId,
      address: address,
    });
  }

  /**
   * Emits a wallet disconnect event.
   * @param {ChainID} params.chainId
   * @param {Address} params.address
   * @returns {Promise<void>}
   */
  async disconnect(params?: { chainId?: ChainID; address?: Address }): Promise<void> {
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
  async chain({ chainId, address }: { chainId: ChainID; address?: Address }): Promise<void> {
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
      chain_id: chainId,
      address: address || this.currentConnectedAddress,
    });
  }

  async signatureStarted({ address, message }: { address: Address; message: string; }): Promise<void> {
    await this.trackEvent(Event.SIGNATURE_STARTED, {
      address,
      message,
    });
  }

  async signatureCompleted({ address, signatureHash, message }: { address: Address; signatureHash: string; message: string; }): Promise<void> {
    await this.trackEvent(Event.SIGNATURE_COMPLETED, {
      address,
      signatureHash,
      message,
    });
  }

  async transaction({ chainId, transactionHash }: { chainId: ChainID; transactionHash: string; }): Promise<void> {
    await this.trackEvent(Event.TRANSACTION, {
      chainId,
      transactionHash,
    });
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
        this._provider.removeListener(
          action,
          this._providerListeners[action]
        );
        delete this._providerListeners[action];
      }
    }

    this._provider = provider;

    // Register listeners for wallet events
    this.getAddress(); // TODO: currently this emits a connect event, but should it?
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
      console.error('_trackSigning: provider not found')
      return
    }
    if (Object.getOwnPropertyDescriptor(this.provider, 'request')?.writable === false) {
      console.warn('_trackSigning: provider.request is not writable')
      return
    }

    const request = this.provider.request.bind(this.provider)
    this.provider.request = async <T>({ method, params }: RequestArguments): Promise<T | null | undefined> => {
      if (Array.isArray(params) && (['eth_signTypedData_v4', 'personal_sign'].includes(method))) {
        if (method === 'eth_signTypedData_v4') {
          this.signatureStarted({
            address: params[0] as Address,
            message: params[1] as string
          })
        }
        if (method === 'personal_sign') {
          const message = Buffer.from((params[0] as string).slice(2), 'hex').toString('utf8');
          this.signatureStarted({
            address: params[1] as Address,
            message
          })
        }

        try {
          const response = await request({ method, params }) as T

          if (method === 'eth_signTypedData_v4') {
            this.signatureCompleted({
              address: params[0] as Address,
              signatureHash: response as string,
              message: params[1] as string
            })
          }
          // https://docs.metamask.io/wallet/reference/json-rpc-methods/personal_sign/
          if (method === 'personal_sign') {
            const message = Buffer.from((params[0] as string).slice(2), 'hex').toString('utf8');
            this.signatureCompleted({
              address: params[1] as Address,
              signatureHash: response as string,
              message
            })
          }
          return response
        } catch (error) {
          throw error
        }
      }
      return request({ method, params })
    }

    return
  }    

  private registerTransactionListener(): void {
    const provider = this.provider
    if (!provider) {
      console.error('_trackTransactions: provider not found')
      return
    }

    if (Object.getOwnPropertyDescriptor(provider, 'request')?.writable === false) {
      console.warn('_trackTransactions: provider.request is not writable')
      return
    }

    // Deliberately not using this._original request to not intefere with the signature tracking's
    // request modification
    const request = provider.request.bind(provider)
    provider.request = async ({ method, params }: RequestArguments) => {
      console.log('transaction listener')
      console.log(method)
      console.log(params)
      if (Array.isArray(params) && method === 'eth_sendTransaction') {
        // _logTransactionSubmitted(provider, params[0] as Record<string, unknown>)
      }
      return request({ method, params })
    }

    return
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

  private async handleDisconnect(chainId?: ChainID, address?: Address): Promise<void> {
    const payload = {
      chain_id: chainId || this.currentChainId,
      address: address || this.currentConnectedAddress,
    };
    this.currentChainId = undefined;
    this.currentConnectedAddress = undefined;

    await this.trackEvent(Event.DISCONNECT, payload);
  }

  private async onAddressDisconnected(): Promise<void> {
    await this.handleDisconnect(this.currentChainId, this.currentConnectedAddress);
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

      // Attempt to fetch and store the connected address
      const address = await this.getAddress();
      if (!address) {
        console.log(
          "FormoAnalytics::onChainChanged: Unable to fetch or store connected address"
        );
        return Promise.resolve();
      }

      this.currentConnectedAddress = address[0];
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

  // TOFIX: support multiple page hit events
  // TODO: Add event listener and support for SPA and hash-based navigation
  // https://linear.app/getformo/issue/P-800/sdk-support-spa-and-hash-based-routing
  private trackPageHit(): void {
    const pathname = window.location.pathname;
    const href = window.location.href;

    setTimeout(async () => {
      this.trackEvent(Event.PAGE, {
        pathname,
        href,
      });
    }, 300);
  }

  // TODO: refactor this with event queue and flushing 
  // https://linear.app/getformo/issue/P-835/sdk-refactor-retries-with-event-queue-and-batching
  private async trackEvent(action: string, payload: any): Promise<void> {
    const address = await this.getAddress();

    const requestData = {
      address: address,
      timestamp: new Date().toISOString(),
      action,
      version: "1",
      payload: await this.buildEventPayload(payload),
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
        console.log("Event sent successfully:", action);
      } else {
        throw new Error(`Failed with status: ${response.status}`);
      }
    } catch (error) {
      H.consumeError(
        error as Error,
        `Request data: ${JSON.stringify(requestData)}`
      );
      console.error(`Event "${action}" failed. Error: ${error}`);
    }
  }

  /*
    Utility functions
  */

  get provider(): EIP1193Provider | undefined {
    return this._provider;
  }    

  private async getAddress(): Promise<Address | null> {
    if (!this.provider) {
      console.log("FormoAnalytics::getAddress: the provider is not set");
      return null;
    }

    try {
      const accounts = await this.getAccounts();
      if (accounts && accounts.length > 0) {
        const address = accounts[0];
        // TODO: how to handle multiple addresses? Should we emit a connect event here? Since the user has not manually connected
        // https://linear.app/getformo/issue/P-691/sdk-detect-multiple-wallets-using-eip6963
        this.onAddressConnected(address); 
        return address;
      }
    } catch (err) {
      console.log("Failed to fetch accounts from provider:", err);
      return null;
    }
    return null;
  }

  private async getAccounts(): Promise<Address[] | null> {
    try {
      const res: string[] | null | undefined = await this.provider?.request({
        method: "eth_accounts",
      });
      if (!res || res.length === 0) {
        console.log(
          "FormoAnalytics::getAccounts: unable to get account. eth_accounts returned empty"
        );
        return null;
      }
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
        console.log(
          "FormoAnalytics::fetchChainId: chain id not found"
        );
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
      return COUNTRY_LIST[timezone as keyof typeof COUNTRY_LIST];
    } catch (error) {
      console.error("Error resolving timezone:", error);
      return undefined;
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
    const address = await this.getAddress();

    // common browser properties
    return {
      "user-agent": window.navigator.userAgent,
      address,
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
}
