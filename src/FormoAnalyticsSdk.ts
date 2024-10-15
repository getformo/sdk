import { SESSION_STORAGE_ID_KEY, USER_ID_KEY } from './constants';

export class FormoAnalyticsSdk {
  private config: any;
  private sessionIdKey: string = SESSION_STORAGE_ID_KEY;
  private userIdKey: string = USER_ID_KEY;
  private timezoneToCountry: Record<string, string> = {
    'Asia/Barnaul': 'RU',
    'Africa/Nouakchott': 'MR',
    'Asia/Calcutta': 'IN',
    // Add the other timezones here
  };

  private constructor(public readonly apiKey: string, config: any) {
    this.config = config;
    this.trackPageHit();
    this.addPageTrackingListeners();
    this.identifyUser({ apiKey: this.apiKey });
  }

  static async init(apiKey: string, config: any): Promise<FormoAnalyticsSdk> {
    const instance = new FormoAnalyticsSdk(apiKey, config);

    return instance;
  }

  private identifyUser(userData: any) {
    const userId = this.getUserId();
    this.trackEvent('identify_user', { userId, ...userData });
    this.setSessionUserId();
  }

  private getUserId(): string {
    let userId = this.getCookieValue(this.userIdKey);
    if (!userId) {
      userId = this.generateUserId(); // Generate a new user ID if not found
    }
    return userId;
  }

  private setSessionUserId(domain?: string) {
    const userId = this.getUserId();
    let cookieValue = `${this.userIdKey}=${userId}; Max-Age=1800; path=/; secure`;
    if (domain) {
      cookieValue += `; domain=${domain}`;
    }
    document.cookie = cookieValue;
  }

  private generateUserId(): string {
    return '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) => {
      const numC = parseInt(c, 10);
      return (
        numC ^
        (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (numC / 4)))
      ).toString(16);
    });
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
      session_id: this.getSessionId(),
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
  track(eventName: string, eventData: any) {
    this.trackEvent(eventName, eventData);
  }

  // Example method to identify a user
  identify(userId: string, userData: any) {
    this.trackEvent('identify_user', { userId, ...userData });
  }
}
