import axios from "axios";
import {
  COUNTRY_LIST,
  EVENTS_API_URL,
  Event,
} from "./constants";
import { H } from "highlight.run";
import { ChainID, Address, EIP1193Provider, Options } from "./types";

interface IFormoAnalytics {
  /**
   * Initializes the FormoAnalytics instance with the provided API key and options.
   */
  init(apiKey: string, options?: Options): Promise<FormoAnalytics>;

  /**
   * Tracks page visit events.
   */
  page(): void;

  /**
   * Connects to a wallet with the specified chain ID and address.
   */
  connect(params: { chainId: ChainID; address: string }): Promise<void>;

  /**
   * Disconnects the current wallet and clears the session information.
   */
  disconnect(params?: { chainId?: ChainID; address?: string }): void;

  /**
   * Switches the blockchain chain context and optionally logs additional params.
   */
  chain(params: { chainId: ChainID; address?: string }): void;

  /**
   * Tracks a specific event with a name and associated data.
   */
  track(eventName: string, eventData: Record<string, any>): void;
}
interface Config {
  token: string;
}
export class FormoAnalytics implements IFormoAnalytics {
  private _provider?: EIP1193Provider;
  private _providerListeners: Record<
    string,
    (...args: unknown[]) => void
  > = {};

  private walletAddressSessionKey = "walletAddress";
  private config: Config;
  private timezoneToCountry: Record<string, string> = COUNTRY_LIST;

  currentChainId?: ChainID;
  currentConnectedAddress?: Address;

  private constructor(
    public readonly apiKey: string,
    public options: Options = {}
  ) {
    this.config = {
      token: this.apiKey,
    };

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

  get provider(): EIP1193Provider | undefined {
    return this._provider;
  }

  // Function to send tracking data
  // TODO: refactor this with event queue and flushing https://linear.app/getformo/issue/P-835/sdk-refactor-retries-with-event-queue-and-batching
  private async trackEvent(action: string, payload: any): Promise<void> {
    const address = await this.getCurrentWallet();

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
            Authorization: `Bearer ${this.apiKey}`,
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

  // Function to track page hits
  // TOFIX: support multiple page hit events
  // TODO: Add event listener and support for SPA and hash-based navigation
  // https://linear.app/getformo/issue/P-800/sdk-support-spa-and-hash-based-routing
  private trackPageHit(): void {
    if (this.isAutomationEnvironment()) return;

    const pathname = window.location.pathname;
    const href = window.location.href;

    setTimeout(async () => {
      this.trackEvent(Event.PAGE, {
        pathname,
        href,
      });
    }, 300);
  }

  private isAutomationEnvironment(): boolean {
    return (
      window.__nightmare ||
      window.navigator.webdriver ||
      window.Cypress ||
      false
    );
  }

  private getUserLocation(): string | undefined {
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      return this.timezoneToCountry[timezone];
    } catch (error) {
      console.error("Error resolving timezone:", error);
      return undefined;
    }
  }

  private getUserLanguage(): string {
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
  async buildEventPayload(
    eventSpecificPayload: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>> {
    const url = new URL(window.location.href);
    const params = new URLSearchParams(url.search);

    const location = this.getUserLocation();
    const language = this.getUserLanguage();

    const address = await this.getAndStoreConnectedAddress();
    if (address === null) {
      console.log("Wallet address could not be retrieved.");
    }

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

  private trackProvider(provider: EIP1193Provider): void {
    if (provider === this._provider) {
      console.log("Provider already tracked.");
      return;
    }

    this.currentChainId = undefined;
    this.currentConnectedAddress = undefined;

    if (this._provider) {
      const eventNames = Object.keys(this._providerListeners);
      for (const eventName of eventNames) {
        this._provider.removeListener(
          eventName,
          this._providerListeners[eventName]
        );
        delete this._providerListeners[eventName];
      }
    }

    console.log("Tracking new provider:", provider);
    this._provider = provider;

    this.getCurrentWallet();
    this.registerAddressChangedListener();
    this.registerChainChangedListener();
    // TODO: track signing and transactions
  }

  private async getAndStoreConnectedAddress(): Promise<Address | null> {
    console.log(
      "Session data missing. Attempting to fetch address from provider."
    );
    try {
      const accounts = await this.fetchAccounts();
      if (accounts && accounts.length > 0) {
        const address = accounts[0];
        this.storeWalletAddress(address);
        return address;
      }
    } catch (err) {
      console.log("Failed to fetch accounts from provider:", err);
    }
    return null;
  }

  private async getCurrentWallet(): Promise<Address | null> {
    if (!this.provider) {
      console.warn("FormoAnalytics::getCurrentWallet: the provider is not set");
      return null;
    }

    const sessionData = sessionStorage.getItem(this.walletAddressSessionKey);
    if (!sessionData) {
      return await this.getAndStoreConnectedAddress();
    }

    const parsedData = JSON.parse(sessionData);
    const sessionExpiry = 30 * 60 * 1000; // 30 minutes
    const currentTime = Date.now();

    if (currentTime - parsedData.timestamp > sessionExpiry) {
      console.log("Session expired. Ignoring wallet address.");
      sessionStorage.removeItem(this.walletAddressSessionKey); // Clear expired session data
      return null;
    }

    this.onAddressConnected(parsedData.address);
    return parsedData.address || null;
  }

  // Utility to fetch accounts
  private async fetchAccounts(): Promise<Address[] | null> {
    try {
      const res: string[] | null | undefined = await this.provider?.request({
        method: "eth_accounts",
      });
      if (!res || res.length === 0) {
        console.log(
          "FormoAnalytics::fetchAccounts: unable to get account. eth_accounts returned empty"
        );
        return null;
      }
      return res;
    } catch (err) {
      if ((err as any).code !== 4001) {
        console.log(
          "FormoAnalytics::fetchAccounts: eth_accounts threw an error",
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

  private async onAddressChanged(addresses: Address[]): Promise<void> {
    if (addresses.length > 0) {
      const newAccount = addresses[0];
      if (newAccount !== this.currentConnectedAddress) {
        this.onAddressConnected(newAccount);
      }
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
    this.storeWalletAddress(address);
  }

  private handleDisconnection(chainId?: ChainID, address?: Address): Promise<void> {
    if (!address) {
      return Promise.resolve();
    }
    const payload = {
      chain_id: chainId || this.currentChainId,
      address,
    };
    this.currentChainId = undefined;
    this.currentConnectedAddress = undefined;
    this.clearWalletAddress();
    return this.trackEvent(Event.DISCONNECT, payload);
  }

  private onAddressDisconnected(): Promise<void> {
    if (!this.currentConnectedAddress) {
      return Promise.resolve();
    }
    return this.handleDisconnection(this.currentChainId, this.currentConnectedAddress);
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
      const address = await this.getAndStoreConnectedAddress();
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

  /**
   * Stores the wallet address in session storage when connected.
   * @param address - The wallet address to store.
   */
  private storeWalletAddress(address: Address): void {
    if (!address) {
      console.log("No wallet address provided to store.");
      return;
    }

    const sessionData = {
      address,
      timestamp: Date.now(),
    };

    sessionStorage.setItem(
      this.walletAddressSessionKey,
      JSON.stringify(sessionData)
    );
  }

  /**
   * Clears the wallet address from session storage when disconnected.
   */
  private clearWalletAddress(): void {
    sessionStorage.removeItem(this.walletAddressSessionKey);
  }

  init(apiKey: string, options: Options): Promise<FormoAnalytics> {
    const instance = new FormoAnalytics(apiKey, options);
    return Promise.resolve(instance);
  }

  connect({ chainId, address }: { chainId: ChainID; address: Address }): Promise<void> {
    if (!chainId) {
      throw new Error("FormoAnalytics::connect: chain ID cannot be empty");
    }
    if (!address) {
      throw new Error("FormoAnalytics::connect: address cannot be empty");
    }

    this.currentChainId = chainId;
    this.currentConnectedAddress = address;

    return this.trackEvent(Event.CONNECT, {
      chain_id: chainId,
      address: address,
    });
  }

  disconnect(params?: { chainId?: ChainID; address?: Address }): Promise<void> {
    const address = params?.address || this.currentConnectedAddress;
    const chainId = params?.chainId || this.currentChainId;
    if (!address) {
      // We have most likely already reported this disconnection with the automatic
      // `disconnect` detection
      return Promise.resolve();
    }
    return this.handleDisconnection(chainId, address);
  }

  chain({ chainId, address }: { chainId: ChainID; address?: Address }): Promise<void> {
    if (!chainId || Number(chainId) === 0) {
      throw new Error("FormoAnalytics::chain: chainId cannot be empty or 0");
    }
    if (!address && !this.currentConnectedAddress) {
      throw new Error(
        "FormoAnalytics::chain: address was empty and no previous address has been recorded. You can either pass an address or call connect() first"
      );
    }
    if (isNaN(Number(chainId))) {
      throw new Error(
        "FormoAnalytics::chain: chainId must be a valid decimal number"
      );
    }

    this.currentChainId = chainId;

    return this.trackEvent(Event.CHAIN_CHANGED, {
      chain_id: chainId,
      address: address || this.currentConnectedAddress,
    });
  }

  page() {
    this.trackPageHit();
  }

  track(eventName: string, eventData: any) {
    this.trackEvent(eventName, eventData);
  }
}
