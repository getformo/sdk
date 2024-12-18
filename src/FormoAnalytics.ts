import axios from 'axios';
import {
  COUNTRY_LIST,
  EVENTS_API_URL,
  SESSION_STORAGE_ID_KEY,
  Event,
} from './constants';
import { H } from 'highlight.run';
import { ChainID, EIP1193Provider, Options } from './types';

interface IFormoAnalytics {
  /**
   * Initializes the FormoAnalytics instance with the provided API key and project ID.
   */
  init(
    apiKey: string,
    options?: Options
  ): Promise<FormoAnalytics>;

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
  private _registeredProviderListeners: Record<
    string,
    (...args: unknown[]) => void
  > = {};

  private walletAddressSessionKey = 'walletAddress';
  private config: Config;
  private sessionIdKey: string = SESSION_STORAGE_ID_KEY;
  private timezoneToCountry: Record<string, string> = COUNTRY_LIST;

  currentChainId?: string | null;
  currentConnectedAddress?: string;

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
    const config = {
      token: apiKey,
    };
    const instance = new FormoAnalytics(apiKey, options);
    instance.config = config;

    return instance;
  }

  get provider(): EIP1193Provider | undefined {
    return this._provider;
  }

  private getSessionId() {
    const existingSessionId = this.getCookieValue(this.sessionIdKey);

    if (existingSessionId) {
      return existingSessionId;
    }

    const newSessionId = this.generateSessionId();
    return newSessionId;
  }

  private getOrigin(): string {
    return window.location.origin || 'ORIGIN_NOT_FOUND';
  }

  // Function to set the session cookie
  private setSessionCookie(): void {
    const sessionId = this.getSessionId();
    let cookieValue = `${
      this.sessionIdKey
    }=${sessionId}; Max-Age=1800; path=/; secure; domain=${this.getOrigin()}`;
    document.cookie = cookieValue;
  }

  // Function to generate a new session ID
  private generateSessionId(): string {
    return crypto.randomUUID();
  }

  // Function to get a cookie value by name
  private getCookieValue(name: string): string | undefined {
    const cookies = document.cookie.split(';').reduce((acc, cookie) => {
      const [key, value] = cookie.split('=');
      acc[key.trim()] = value;
      return acc;
    }, {} as Record<string, string>);
    return cookies[name];
  }

  // Function to send tracking data
  private async trackEvent(action: string, payload: any) {
    const maxRetries = 3;
    let attempt = 0;

    this.setSessionCookie();
    const address = await this.getCurrentWallet();

    const requestData = {
      address: address,
      session_id: this.getSessionId(),
      timestamp: new Date().toISOString(),
      action,
      version: '1',
      payload,
    };

    const sendRequest = async (): Promise<void> => {
      try {
        const response = await axios.post(
          EVENTS_API_URL,
          JSON.stringify(requestData),
          {
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${this.apiKey}`,
            },
          }
        );

        if (response.status >= 200 && response.status < 300) {
          console.log('Event sent successfully:', action);
        } else {
          throw new Error(`Failed with status: ${response.status}`);
        }
      } catch (error) {
        attempt++;

        if (attempt <= maxRetries) {
          const retryDelay = Math.pow(2, attempt) * 1000;
          console.error(
            `Attempt ${attempt}: Retrying event "${action}" in ${
              retryDelay / 1000
            } seconds...`
          );
          setTimeout(sendRequest, retryDelay);
        } else {
          H.consumeError(
            error as Error,
            `Request data: ${JSON.stringify(requestData)}`
          );
          console.error(
            `Event "${action}" failed after ${maxRetries} attempts. Error: ${error}`
          );
        }
      }
    };

    await sendRequest();
  }

  // Function to track page hits
  private trackPageHit() {
    if (window.__nightmare || window.navigator.webdriver || window.Cypress)
      return;

    let location: string | undefined;
    let language: string;
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      location = this.timezoneToCountry[timezone];
      language =
        navigator.languages && navigator.languages.length
          ? navigator.languages[0]
          : navigator.language || 'en';
    } catch (error) {
      console.error('Error resolving timezone or language:', error);
    }

    setTimeout(() => {
      const url = new URL(window.location.href);
      const params = new URLSearchParams(url.search);
      this.trackEvent(Event.PAGE, {
        'user-agent': window.navigator.userAgent,
        address: this.currentConnectedAddress,
        locale: language,
        location: location,
        referrer: document.referrer,
        pathname: window.location.pathname,
        href: window.location.href,
        utm_source: params.get('utm_source'),
        utm_medium: params.get('utm_medium'),
        utm_campaign: params.get('utm_campaign'),
        ref: params.get('ref'),
      });
    }, 300);
  }

  private trackProvider(provider: EIP1193Provider) {
    if (provider === this._provider) {
      console.log('Provider already tracked.');
      return;
    }

    this.currentChainId = undefined;
    this.currentConnectedAddress = undefined;

    if (this._provider) {
      const eventNames = Object.keys(this._registeredProviderListeners);
      for (const eventName of eventNames) {
        this._provider.removeListener(
          eventName,
          this._registeredProviderListeners[eventName]
        );
        delete this._registeredProviderListeners[eventName];
      }
    }

    console.log('Tracking new provider:', provider);
    this._provider = provider;

    this.getCurrentWallet();
    this.registerAddressChangedListener();
    this.registerChainChangedListener();
  }

  private async getCurrentWallet() {
    if (!this.provider) {
      console.warn('FormoAnalytics::getCurrentWallet: the provider is not set');
      return;
    }

    const sessionData = sessionStorage.getItem(this.walletAddressSessionKey);

    if (!sessionData) {
      console.warn(
        'Session data missing. Attempting to fetch address from provider.'
      );
      try {
        const accounts = await this.provider.request<string[]>({
          method: 'eth_accounts',
        });
        if (accounts && accounts.length > 0) {
          const address = accounts[0];
          this.storeWalletAddress(address);
          return address;
        }
      } catch (err) {
        console.error('Failed to fetch accounts from provider:', err);
      }
      return null;
    }

    const parsedData = JSON.parse(sessionData);
    const sessionExpiry = 30 * 60 * 1000; // 30 minutes
    const currentTime = Date.now();

    if (currentTime - parsedData.timestamp > sessionExpiry) {
      console.warn('Session expired. Ignoring wallet address.');
      sessionStorage.removeItem(this.walletAddressSessionKey); // Clear expired session data
      return '';
    }

    this.onAddressConnected(parsedData.address);
    return parsedData.address || '';
  }

  private async getCurrentChainId(): Promise<string> {
    if (!this.provider) {
      console.error('FormoAnalytics::getCurrentChainId: provider not set');
    }
    const chainIdHex = await this.provider?.request<string>({
      method: 'eth_chainId',
    });
    // Because we're connected, the chainId cannot be null
    if (!chainIdHex) {
      console.error(
        `FormoAnalytics::getCurrentChainId: chainIdHex is: ${chainIdHex}`
      );
    }

    return parseInt(chainIdHex as string, 16).toString();
  }

  private registerAddressChangedListener() {
    const listener = (...args: unknown[]) =>
      this.onAddressChanged(args[0] as string[]);

    this._provider?.on('accountsChanged', listener);
    this._registeredProviderListeners['accountsChanged'] = listener;

    const onAddressDisconnected = this.onAddressDisconnected.bind(this);
    this._provider?.on('disconnect', onAddressDisconnected);
    this._registeredProviderListeners['disconnect'] = onAddressDisconnected;
  }

  private registerChainChangedListener() {
    const listener = (...args: unknown[]) =>
      this.onChainChanged(args[0] as string);
    this.provider?.on('chainChanged', listener);
    this._registeredProviderListeners['chainChanged'] = listener;
  }

  private async onAddressChanged(addresses: string[]) {
    if (addresses.length > 0) {
      const newAccount = addresses[0];
      if (newAccount !== this.currentConnectedAddress) {
        this.onAddressConnected(newAccount);
      }
    } else {
      this.onAddressDisconnected();
    }
  }

  private async onAddressConnected(address: string) {
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

  private onAddressDisconnected() {
    if (!this.currentConnectedAddress) {
      return;
    }

    const payload = {
      chain_id: this.currentChainId,
      address: this.currentConnectedAddress,
    };
    this.currentChainId = undefined;
    this.currentConnectedAddress = undefined;
    this.clearWalletAddress();

    return this.trackEvent(Event.DISCONNECT, payload);
  }

  private async onChainChanged(chainIdHex: string) {
    this.currentChainId = parseInt(chainIdHex).toString();
    if (!this.currentConnectedAddress) {
      if (!this.provider) {
        console.error(
          'error',
          'FormoAnalytics::onChainChanged: provider not found. CHAIN_CHANGED not reported'
        );
        return;
      }

      try {
        const res: string[] | null | undefined = await this.provider.request({
          method: 'eth_accounts',
        });
        if (!res || res.length === 0) {
          console.error(
            'error',
            'FormoAnalytics::onChainChanged: unable to get account. eth_accounts returned empty'
          );
          return;
        }

        this.currentConnectedAddress = res[0];
      } catch (err) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((err as any).code !== 4001) {
          // 4001: The request is rejected by the user , see https://docs.metamask.io/wallet/reference/provider-api/#errors
          console.error(
            'error',
            `FormoAnalytics::onChainChanged: unable to get account. eth_accounts threw an error`,
            err
          );
          return;
        }
      }
    }

    return this.chain({
      chainId: this.currentChainId,
      address: this.currentConnectedAddress,
    });
  }

  /**
   * Stores the wallet address in session storage when connected.
   * @param address - The wallet address to store.
   */
  private storeWalletAddress(address: string): void {
    if (!address) {
      console.error('No wallet address provided to store.');
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

  connect({ chainId, address }: { chainId: ChainID; address: string }) {
    if (!chainId) {
      throw new Error('FormoAnalytics::connect: chain ID cannot be empty');
    }
    if (!address) {
      throw new Error('FormoAnalytics::connect: address cannot be empty');
    }

    this.currentChainId = chainId.toString();
    this.currentConnectedAddress = address;

    return this.trackEvent(Event.CONNECT, {
      chain_id: chainId,
      address: address,
    });
  }

  disconnect(params?: { chainId?: ChainID; address?: string }) {
    const address = params?.address || this.currentConnectedAddress;
    if (!address) {
      // We have most likely already reported this disconnection with the automatic
      // `disconnect` detection
      return;
    }

    const payload = {
      chain_id: params?.chainId || this.currentChainId,
      address,
    };
    this.currentChainId = undefined;
    this.currentConnectedAddress = undefined;

    return this.trackEvent(Event.DISCONNECT, payload);
  }

  chain({ chainId, address }: { chainId: ChainID; address?: string }) {
    if (!chainId || Number(chainId) === 0) {
      throw new Error('FormoAnalytics::chain: chainId cannot be empty or 0');
    }
    if (!address && !this.currentConnectedAddress) {
      throw new Error(
        'FormoAnalytics::chain: address was empty and no previous address has been recorded. You can either pass an address or call connect() first'
      );
    }
    if (isNaN(Number(chainId))) {
      throw new Error(
        'FormoAnalytics::chain: chainId must be a valid hex or decimal number'
      );
    }

    this.currentChainId = chainId.toString();

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
