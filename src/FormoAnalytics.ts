import axios from 'axios';
import { COUNTRY_LIST, EVENTS_API, SESSION_STORAGE_ID_KEY } from './constants';
import { isNotEmpty } from './utils';

interface IFormoAnalytics {
  init(apiKey: string, projectId: string): Promise<FormoAnalytics>;
  identify(userData: any): void;
  page(): void;
  track(eventName: string, eventData: any): void;
}
export class FormoAnalytics implements IFormoAnalytics {
  private config: any;
  private sessionIdKey: string = SESSION_STORAGE_ID_KEY;
  private timezoneToCountry: Record<string, string> = COUNTRY_LIST;

  private constructor(
    public readonly apiKey: string,
    public projectId: string
  ) {
    this.config = {
      token: this.apiKey,
    };
  }
  static async init(
    apiKey: string,
    projectId: string
  ): Promise<FormoAnalytics> {
    const config = {
      token: apiKey,
    };
    const instance = new FormoAnalytics(apiKey, projectId);
    instance.config = config;

    return instance;
  }

  private identifyUser(userData: any) {
    this.trackEvent('identify_user', userData);
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
    const retries = 3;
    this.setSessionCookie(this.config.domain);
    const apiUrl = this.buildApiUrl();

    const requestData = {
      timestamp: new Date().toISOString(),
      action: action,
      version: '1',
      session_id: this.getSessionId(),
      payload: isNotEmpty(payload) ? this.maskSensitiveData(payload) : payload,
      project_id: this.projectId,
    };

    console.log('Request data:', JSON.stringify(requestData));

    try {
      const response = await axios.post(apiUrl, JSON.stringify(requestData), {
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (response.status >= 200 && response.status < 300) {
        console.log('Event sent successfully:', action);
      } else {
        console.error('Event sending failed with status:', response.status);
        this.handleFailedEvent(action, payload, retries);
      }
    } catch (error) {
      console.error(
        'Network or server error occurred while sending event:',
        error
      );
      this.handleFailedEvent(action, payload, retries);
    }
  }

  // Handle failed event transmission and retry
  private handleFailedEvent(action: string, payload: any, retries: number) {
    if (retries > 0) {
      const retryDelay = Math.pow(2, 3 - retries) * 1000; // Exponential backoff
      console.log(
        `Retrying event "${action}" in ${retryDelay / 1000} seconds...`
      );

      setTimeout(() => {
        this.trackEvent(action, payload); // Retry sending event
      }, retryDelay);
    } else {
      console.error(`Event "${action}" failed after multiple retries.`);
      // You can also choose to store the failed event for future attempts
    }
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
      data = data?.replace(
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
