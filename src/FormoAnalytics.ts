import axios from 'axios';
import { COUNTRY_LIST, EVENTS_API, SESSION_STORAGE_ID_KEY } from './constants';
import { isNotEmpty } from './utils';
import { H } from 'highlight.run';

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
    this.trackPageHit();
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
    this.trackEvent('identify', userData);
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

    const requestData = {
      project_id: this.projectId,
      address: '', // TODO: get cached / session wallet address
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
        H.consumeError(
          error as Error,
          `Request data: ${JSON.stringify(requestData)}`
        );

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
      this.trackEvent('page_hit', {
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
