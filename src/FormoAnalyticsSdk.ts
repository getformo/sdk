import { IDENTITY_KEY, SDK_VERSION, SESSION_STORAGE_ID_KEY } from './constants';
import { Socket } from 'socket.io-client';
import { SdkConfig } from './types';
import { createClientSocket, generateID, postRequest } from './utils';

export class FormoAnalyticsSdk {
  private config: any;
  private sessionIdKey: string = SESSION_STORAGE_ID_KEY;
  private timezoneToCountry: Record<string, string> = {
    'Asia/Barnaul': 'RU',
    'Africa/Nouakchott': 'MR',
    'Asia/Calcutta': 'IN',
    // Add the other timezones here
  };

  private constructor(
    public readonly apiKey: string,
    config: any,
    public readonly identityId: string,
    private socket: Socket
  ) {
    this.config = config;
    this.trackPageHit();
    this.addPageTrackingListeners();

    this._registerSocketListeners(socket);

    socket.once('error', (error) => {
      if (['InternalServerError', 'BadRequestError'].includes(error.name)) {
        window.localStorage.removeItem(IDENTITY_KEY);
        FormoAnalyticsSdk._getIdentitityId(this.config, this.apiKey).then(
          (identityId) => {
            this.socket = createClientSocket(this.config.url, {
              apiKey: this.apiKey,
              identityId,
              sdkVersion: SDK_VERSION,
              screenHeight: screen.height,
              screenWidth: screen.width,
              viewportHeight: window.innerHeight,
              viewportWidth: window.innerWidth,
              url: window.location.href,
              sessionStorageId: FormoAnalyticsSdk._getSessionId(identityId),
            });
            this._registerSocketListeners(this.socket);
          }
        );
      }
    });
  }

  static async init(apiKey: string, config: any): Promise<FormoAnalyticsSdk> {
    const identityId = await FormoAnalyticsSdk._getIdentitityId(
      config,
      apiKey
    );
    const sessionId = FormoAnalyticsSdk._getSessionId(identityId);

    const websocket = createClientSocket(config.url, {
      apiKey,
      identityId,
      sdkVersion: SDK_VERSION,
      screenHeight: screen.height,
      screenWidth: screen.width,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      url: window.location.href,
      sessionStorageId: sessionId,
    });

    const instance = new FormoAnalyticsSdk(
      apiKey,
      identityId,
      config,
      websocket
    );

    return instance;
  }

  private _registerSocketListeners(socket: Socket) {
    socket.on('error', (error) => {
      console.error('error event received from socket', error);
    });
  }

  private static async _getIdentitityId(sdkConfig: SdkConfig, apiKey: string) {
    const identityId =
      (sdkConfig?.cacheIdentity && window.localStorage.getItem(IDENTITY_KEY)) ||
      (await postRequest(sdkConfig.url, apiKey, '/identify'));
    sdkConfig?.cacheIdentity &&
      window.localStorage.setItem(IDENTITY_KEY, identityId);
    return identityId;
  }

  private static _getSessionId(identityId: string) {
    const existingSessionId = window.sessionStorage.getItem(
      SESSION_STORAGE_ID_KEY
    );
    if (existingSessionId) {
      return existingSessionId;
    }

    const newSessionId = generateID(identityId);
    window.sessionStorage.setItem(SESSION_STORAGE_ID_KEY, newSessionId);
    return newSessionId;
  }

  // Function to set the session cookie
  private setSessionCookie(domain?: string) {
    const sessionId =
      this.getCookieValue(this.sessionIdKey) || this.generateSessionId();
    let cookieValue = `${this.sessionIdKey}=${sessionId}; Max-Age=1800; path=/; secure`;
    if (domain) {
      cookieValue += `; domain=${domain}`;
    }
    document.cookie = cookieValue;
  }

  // Function to generate a new session ID
  private generateSessionId(): string {
    return '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) => {
      const numC = parseInt(c, 10);
      return (
        numC ^
        (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (numC / 4)))
      ).toString(16);
    });
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
    this.setSessionCookie(this.config.domain);
    const apiUrl = this.buildApiUrl();

    const requestData = {
      timestamp: new Date().toISOString(),
      action: action,
      version: '1',
      session_id: this.getCookieValue(this.sessionIdKey),
      payload: this.maskSensitiveData(payload),
    };

    const xhr = new XMLHttpRequest();
    xhr.open('POST', apiUrl, true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.send(JSON.stringify(requestData));
  }

  // Function to mask sensitive data in the payload
  private maskSensitiveData(data: string): string {
    const sensitiveFields = [
      'username',
      'user',
      'user_id',
      'password',
      'email',
      'phone',
    ];
    sensitiveFields.forEach((field) => {
      data = data.replace(
        new RegExp(`("${field}"):(".+?"|\\d+)`, 'mgi'),
        `$1:"********"`
      );
    });
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
      this.trackEvent('page_hit', {
        'user-agent': window.navigator.userAgent,
        locale: language,
        location: location,
        referrer: document.referrer,
        pathname: window.location.pathname,
        href: window.location.href,
      });
    }, 300);
  }

  // Function to build the API URL
  private buildApiUrl(): string {
    const { host, proxy, token, dataSource = 'analytics_events' } = this.config;
    if (proxy) {
      return `${proxy}/api/tracking`;
    }
    if (host) {
      return `${host.replace(
        /\/+$/,
        ''
      )}/v0/events?name=${dataSource}&token=${token}`;
    }
    return `https://api.tinybird.co/v0/events?name=${dataSource}&token=${token}`;
  }

  // Add event listeners for tracking page views
  private addPageTrackingListeners() {
    window.addEventListener('hashchange', this.trackPageHit.bind(this));

    const history = window.history;
    if (history.pushState) {
      const originalPushState = history.pushState;
      history.pushState = (...args) => {
        originalPushState.apply(history, args);
        this.trackPageHit();
      };
      window.addEventListener('popstate', this.trackPageHit.bind(this));
    }

    if ((document.visibilityState as unknown) === 'prerender') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          this.trackPageHit();
        }
      });
    } else {
      this.trackPageHit();
    }
  }

  // Example method to track custom events
  trackCustomEvent(eventName: string, eventData: any) {
    this.trackEvent(eventName, eventData);
  }

  // Example method to identify a user
  identifyUser(userId: string, userData: any) {
    this.trackEvent('identify_user', { userId, ...userData });
  }
}
