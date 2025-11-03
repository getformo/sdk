import {
  ITrafficSource,
  ReferralOptions,
  UTMParameters,
} from "../../types";
import { SESSION_TRAFFIC_SOURCE_KEY } from "../../constants";
import { logger } from "../logger";
import { session } from "../storage";
import { isUndefined } from "../../validators";

/**
 * Service for parsing and managing traffic source information from URLs
 */
export class TrafficSource {
  private referralOptions?: ReferralOptions;

  constructor(referralOptions?: ReferralOptions) {
    this.referralOptions = referralOptions;
  }

  /**
   * Extracts UTM parameters from a URL
   */
  private extractUTMParameters = (url: string): UTMParameters => {
    const result: UTMParameters = {
      utm_campaign: "",
      utm_content: "",
      utm_medium: "",
      utm_source: "",
      utm_term: "",
    };
    try {
      const urlObj = new URL(url);
      const UTM_PREFIX = "utm_";
      urlObj.searchParams.forEach((value, sParam) => {
        if (sParam.startsWith(UTM_PREFIX)) {
          result[sParam as keyof UTMParameters] = value.trim();
        }
      });
    } catch (error) {
      // Silently handle URL parsing errors
    }
    return result;
  };

  /**
   * Extracts referral parameter from URL using configured query params and path patterns
   */
  private extractReferralParameter = (urlObj: URL): string => {
    // Get query parameter names to check (default or custom)
    const defaultParams = ["ref", "referral", "refcode"];
    const referralParams =
      this.referralOptions?.queryParams || defaultParams;

    // Check query parameters first
    for (const param of referralParams) {
      const value = urlObj.searchParams.get(param)?.trim();
      if (value) return value;
    }

    // Check URL path patterns if configured
    if (this.referralOptions?.pathPatterns?.length) {
      const pathname = urlObj.pathname;
      for (const pattern of this.referralOptions.pathPatterns) {
        try {
          const regex = new RegExp(pattern);
          const match = pathname.match(regex);
          if (match && match[1]) {
            const referralCode = match[1].trim();
            if (referralCode) return referralCode;
          }
        } catch (error) {
          logger.warn(
            `Invalid referral path pattern: ${pattern}. Error: ${error}`
          );
        }
      }
    }

    return "";
  };

  /**
   * Parses traffic sources from a URL and stores them in session storage
   * @param url The URL to parse
   * @returns Parsed traffic source information
   */
  parseAndStore(url: string): ITrafficSource {
    try {
      const urlObj = new URL(url);
      const contextTrafficSources: ITrafficSource = {
        ...this.extractUTMParameters(url),
        ref: this.extractReferralParameter(urlObj),
        referrer: document.referrer,
      };
      const storedTrafficSources =
        (session().get(SESSION_TRAFFIC_SOURCE_KEY) as ITrafficSource) || {};

      const finalTrafficSources: ITrafficSource = {
        ref: contextTrafficSources.ref || storedTrafficSources?.ref || "",
        referrer:
          contextTrafficSources.referrer || storedTrafficSources?.referrer || "",
        utm_campaign:
          contextTrafficSources.utm_campaign ||
          storedTrafficSources?.utm_campaign ||
          "",
        utm_content:
          contextTrafficSources.utm_content ||
          storedTrafficSources?.utm_content ||
          "",
        utm_medium:
          contextTrafficSources.utm_medium ||
          storedTrafficSources?.utm_medium ||
          "",
        utm_source:
          contextTrafficSources.utm_source ||
          storedTrafficSources?.utm_source ||
          "",
        utm_term:
          contextTrafficSources.utm_term || storedTrafficSources?.utm_term || "",
      };

      // Store to session
      const sessionStoredTrafficSources = Object.keys(finalTrafficSources).reduce(
        (res: any, key: any) => {
          const value = finalTrafficSources[key as keyof ITrafficSource];
          if (!isUndefined(value) && value !== "") {
            res[key as keyof ITrafficSource] = value;
          }
          return res;
        },
        {}
      );

      if (Object.keys(sessionStoredTrafficSources).length)
        session().set(SESSION_TRAFFIC_SOURCE_KEY, sessionStoredTrafficSources);

      return finalTrafficSources;
    } catch (error) {
      logger.error("Error parsing traffic sources:", error);
      // Return stored traffic sources or empty object on error
      return (
        (session().get(SESSION_TRAFFIC_SOURCE_KEY) as ITrafficSource) || {
          ref: "",
          referrer: "",
          utm_campaign: "",
          utm_content: "",
          utm_medium: "",
          utm_source: "",
          utm_term: "",
        }
      );
    }
  }

  /**
   * Retrieves stored traffic sources from session storage
   * @returns Stored traffic source information or empty defaults
   */
  getStored(): ITrafficSource {
    const stored = session().get(SESSION_TRAFFIC_SOURCE_KEY) as ITrafficSource;
    if (stored) {
      return stored;
    }
    return {
      ref: "",
      referrer: document.referrer || "",
      utm_campaign: "",
      utm_content: "",
      utm_medium: "",
      utm_source: "",
      utm_term: "",
    };
  }
}
