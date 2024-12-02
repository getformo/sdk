import axios from 'axios';
import {
  COUNTRY_LIST,
  EVENTS_API,
  SESSION_STORAGE_ID_KEY,
  Event,
} from './constants';
import { isNotEmpty } from './utils';
import { H } from 'highlight.run';
import { ChainID, EIP1193Provider, RequestArguments } from './types';

interface IFormoAnalytics {
  /**
   * Initializes the FormoAnalytics instance with the provided API key and project ID.
   */
  init(apiKey: string, projectId: string): Promise<FormoAnalytics>;

  /**
   * Identifies the user with the provided user data.
   */
  identify(userData: Record<string, any>): void;

  /**
   * Tracks page visit events.
   */
  page(): void;

  /**
   * Connects to a wallet with the specified chain ID and address.
   */
  connect(params: { account: string; chainId: ChainID }): Promise<void>;

  /**
   * Disconnects the current wallet and clears the session information.
   */
  disconnect(attributes?: { account?: string; chainId?: ChainID }): void;

  /**
   * Tracks a specific event with a name and associated data.
   */
  track(eventName: string, eventData: Record<string, any>): void;

  /**
   * Switches the blockchain chain context and optionally logs additional attributes.
   */
  chain(attributes: { chainId: ChainID; account?: string }): void;
}
interface Options {
  provider?: EIP1193Provider;
}
export class FormoAnalytics implements IFormoAnalytics {
  private _provider?: EIP1193Provider;
  private _registeredProviderListeners: Record<
    string,
    (...args: unknown[]) => void
  > = {};

  private sessionKey = 'walletAddress';
  private config: any;
  private sessionIdKey: string = SESSION_STORAGE_ID_KEY;
  private timezoneToCountry: Record<string, string> = COUNTRY_LIST;

  currentChainId?: string | null;
  currentConnectedAccount?: string;

  private constructor(
    public readonly apiKey: string,
    public projectId: string,
    public options: Options
  ) {
    this.config = {
      token: this.apiKey,
    };

    const provider = window?.ethereum || window.web3?.currentProvider || options.provider;
    if (provider) {
      this.trackProvider(provider);
    }
  }

  static async init(
    apiKey: string,
    projectId: string,
    options: Options
  ): Promise<FormoAnalytics> {
    const config = {
      token: apiKey,
    };
    const instance = new FormoAnalytics(apiKey, projectId, options);
    instance.config = config;

    return instance;
  }

  get provider(): EIP1193Provider | undefined {
    return this._provider;
  }

  private identifyUser(userData: any) {
    this.trackEvent(Event.IDENTIFY, userData);
  }

  private getSessionId() {
    const existingSessionId = this.getCookieValue(this.sessionIdKey);

    if (existingSessionId) {
      return existingSessionId;
    }

    const newSessionId = this.generateSessionId();
    return newSessionId;
  }

  // Function to set the session cookie
  private setSessionCookie(domain?: string) {
    const sessionId = this.getSessionId();
    let cookieValue = `${this.sessionIdKey}=${sessionId}; Max-Age=1800; path=/; secure`;
    if (domain) {
      cookieValue += `; domain=${domain}`;
    }
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

    this.setSessionCookie(this.config.domain);
    const apiUrl = this.buildApiUrl();
    const address = await this.getCurrentWallet();

    const requestData = {
      project_id: this.projectId,
      address: address,
      session_id: this.getSessionId(),
      timestamp: new Date().toISOString(),
      action: action,
      version: '1',
      payload: isNotEmpty(payload) ? this.maskSensitiveData(payload) : payload,
    };

    const sendRequest = async (): Promise<void> => {
      try {
        const response = await axios.post(apiUrl, JSON.stringify(requestData), {
          headers: {
            'Content-Type': 'application/json',
          },
        });

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

  // Function to mask sensitive data in the payload
  private maskSensitiveData(
    data: string | undefined | null
  ): Record<string, any> | null {
    // Check if data is null or undefined
    if (data === null || data === undefined) {
      console.warn('Data is null or undefined, returning null');
      return null;
    }

    // Check if data is a string; if so, parse it to an object
    if (typeof data === 'string') {
      let parsedData: Record<string, any>;
      try {
        parsedData = JSON.parse(data);
      } catch (error) {
        console.error('Failed to parse JSON:', error);
        return null; // Return null if parsing fails
      }

      const sensitiveFields = [
        'username',
        'user',
        'user_id',
        'password',
        'email',
        'phone',
      ];

      // Create a new object to store masked data
      const maskedData = { ...parsedData };

      // Mask sensitive fields
      sensitiveFields.forEach((field) => {
        if (field in maskedData) {
          maskedData[field] = '********'; // Replace value with masked string
        }
      });

      return maskedData; // Return the new object with masked fields
    } else if (typeof data === 'object') {
      // If data is already an object, handle masking directly
      const sensitiveFields = [
        'username',
        'user',
        'user_id',
        'password',
        'email',
        'phone',
      ];

      const maskedData = { ...(data as Record<string, any>) };

      // Mask sensitive fields
      sensitiveFields.forEach((field) => {
        if (field in maskedData) {
          maskedData[field] = '********'; // Replace value with masked string
        }
      });

      return maskedData; // Return the new object with masked fields
    }

    return data;
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
      return;
    }

    this.currentChainId = undefined;
    this.currentConnectedAccount = undefined;

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

    this._provider = provider;

    this.getCurrentWallet();
    this.registerAccountsChangedListener();
    this.registerChainChangedListener();
  }

  private registerChainChangedListener() {
    const listener = (...args: unknown[]) =>
      this.onChainChanged(args[0] as string);
    this.provider?.on('chainChanged', listener);
    this._registeredProviderListeners['chainChanged'] = listener;
  }

  private handleAccountDisconnected() {
    if (!this.currentConnectedAccount) {
      return;
    }

    const disconnectAttributes = {
      address: this.currentConnectedAccount,
      chainId: this.currentChainId,
    };
    this.currentChainId = undefined;
    this.currentConnectedAccount = undefined;
    this.clearWalletAddress();

    return this.trackEvent(Event.DISCONNECT, disconnectAttributes);
  }

  private async onChainChanged(chainIdHex: string) {
    this.currentChainId = parseInt(chainIdHex).toString();
    if (!this.currentConnectedAccount) {
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

        this.currentConnectedAccount = res[0];
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
      account: this.currentConnectedAccount,
    });
  }

  private async onAccountsChanged(accounts: string[]) {
    if (accounts.length > 0) {
      const newAccount = accounts[0];
      if (newAccount !== this.currentConnectedAccount) {
        this.handleAccountConnected(newAccount);
      }
    } else {
      this.handleAccountDisconnected();
    }
  }

  private registerAccountsChangedListener() {
    const listener = (...args: unknown[]) =>
      this.onAccountsChanged(args[0] as string[]);

    this._provider?.on('accountsChanged', listener);
    this._registeredProviderListeners['accountsChanged'] = listener;

    const handleAccountDisconnected = this.handleAccountDisconnected.bind(this);
    this._provider?.on('disconnect', handleAccountDisconnected);
    this._registeredProviderListeners['disconnect'] = handleAccountDisconnected;
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

  private async handleAccountConnected(account: string) {
    if (account === this.currentConnectedAccount) {
      // We have already reported this account
      return;
    } else {
      this.currentConnectedAccount = account;
    }

    this.currentChainId = await this.getCurrentChainId();

    this.connect({ account, chainId: this.currentChainId });
    this.storeWalletAddress(account);
  }

  private async getCurrentWallet() {
    if (!this.provider) {
      console.warn('FormoAnalytics::getCurrentWallet: the provider is not set');
      return;
    }
    const sessionData = sessionStorage.getItem(this.sessionKey);

    if (!sessionData) {
      return null;
    }

    const parsedData = JSON.parse(sessionData);
    const sessionExpiry = 30 * 60 * 1000; // 30 minutes
    const currentTime = Date.now();

    if (currentTime - parsedData.timestamp > sessionExpiry) {
      console.warn('Session expired. Ignoring wallet address.');
      sessionStorage.removeItem(this.sessionKey); // Clear expired session data
      return '';
    }

    this.handleAccountConnected(parsedData.address);
    return parsedData.address || '';
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

    sessionStorage.setItem(this.sessionKey, JSON.stringify(sessionData));
  }

  /**
   * Clears the wallet address from session storage when disconnected.
   */
  private clearWalletAddress(): void {
    sessionStorage.removeItem(this.sessionKey);
  }

  // Function to build the API URL
  private buildApiUrl(): string {
    const { host, proxy, token, dataSource = 'analytics_events' } = this.config;
    if (token) {
      if (proxy) {
        return `${proxy}/api/tracking`;
      }
      if (host) {
        return `${host.replace(
          /\/+$/,
          ''
        )}/v0/events?name=${dataSource}&token=${token}`;
      }
      return `${EVENTS_API}?name=${dataSource}&token=${token}`;
    }
    return 'Error: No token provided';
  }

  connect({ account, chainId }: { account: string; chainId: ChainID }) {
    if (!chainId) {
      throw new Error('FormoAnalytics::connect: chainId cannot be empty');
    }
    if (!account) {
      throw new Error('FormoAnalytics::connect: account cannot be empty');
    }

    this.currentChainId = chainId.toString();
    this.currentConnectedAccount = account;

    return this.trackEvent(Event.CONNECT, {
      chainId,
      address: account,
    });
  }

  disconnect(attributes?: { account?: string; chainId?: ChainID }) {
    const account = attributes?.account || this.currentConnectedAccount;
    if (!account) {
      // We have most likely already reported this disconnection with the automatic
      // `disconnect` detection
      return;
    }

    const chainId = attributes?.chainId || this.currentChainId;
    const eventAttributes = {
      account,
      ...(chainId && { chainId }),
    };

    this.currentChainId = undefined;
    this.currentConnectedAccount = undefined;

    return this.trackEvent(Event.DISCONNECT, eventAttributes);
  }

  chain({ chainId, account }: { chainId: ChainID; account?: string }) {
    if (!chainId || Number(chainId) === 0) {
      throw new Error('FormoAnalytics::chain: chainId cannot be empty or 0');
    }

    if (!account && !this.currentConnectedAccount) {
      throw new Error(
        'FormoAnalytics::chain: account was empty and no previous account has been recorded. You can either pass an account or call connect() first'
      );
    }

    if (isNaN(Number(chainId))) {
      throw new Error(
        'FormoAnalytics::chain: chainId must be a valid hex or decimal number'
      );
    }

    this.currentChainId = chainId.toString();

    return this.trackEvent(Event.CHAIN_CHANGED, {
      chainId,
      account: account || this.currentConnectedAccount,
    });
  }

  init(apiKey: string, projectId: string): Promise<FormoAnalytics> {
    const instance = new FormoAnalytics(apiKey, projectId);

    return Promise.resolve(instance);
  }

  identify(userData: any) {
    this.identifyUser(userData);
  }

  page() {
    this.trackPageHit();
  }

  track(eventName: string, eventData: any) {
    this.trackEvent(eventName, eventData);
  }
}
