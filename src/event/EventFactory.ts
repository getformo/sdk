import {
  COUNTRY_LIST,
  LOCAL_ANONYMOUS_ID_KEY,
  SESSION_TRAFFIC_SOURCE_KEY,
} from "../constants";
import {
  Address,
  APIEvent,
  ChainID,
  ClickIdParameters,
  IFormoEvent,
  IFormoEventContext,
  IFormoEventProperties,
  ITrafficSource,
  Nullable,
  Options,
  SignatureStatus,
  TransactionStatus,
  UTMParameters,
} from "../types";
import { toSnakeCase, getTimezone } from "../utils";
import { validateAddress } from "../utils/address";
import { getCurrentTimeFormatted } from "../utils/timestamp";
import { isUndefined } from "../validators";
import { logger } from "../logger";
import mergeDeepRight from "../ramda/mergeDeepRight";
import { session } from "../storage";
import { version } from "../version";
import {
  CHANNEL,
  CLICK_ID_PARAMS,
  DEFAULT_EXCLUDED_QUERY_PARAMS,
  DEFAULT_REFERRAL_PARAMS,
  PAGE_PROPERTIES_EXCLUDED_FIELDS,
  VERSION,
} from "./constants";
import { IEventFactory } from "./type";
import { generateAnonymousId } from "./utils";
import { detectBrowser } from "../browser/browsers";

const ISO_3166_ALPHA_2_REGEX = /^[A-Z]{2}$/;

class EventFactory implements IEventFactory {
  private options?: Options;
  private compiledPathPattern?: RegExp;
  // Lower-cased query-param keys that must never be forwarded to or stored by
  // Formo: a built-in always-on denylist (DEFAULT_EXCLUDED_QUERY_PARAMS) merged
  // with any opt-in keys from `options.tracking.excludeQueryParams`. The
  // built-ins are always present and cannot be removed by configuration.
  private excludedQueryParams: Set<string>;

  constructor(options?: Options) {
    this.options = options;
    const tracking = options?.tracking;
    const configuredExcludes =
      typeof tracking === "object" ? tracking.excludeQueryParams ?? [] : [];
    this.excludedQueryParams = new Set(
      [...DEFAULT_EXCLUDED_QUERY_PARAMS, ...configuredExcludes].map((key) =>
        key.toLowerCase()
      )
    );
    // Compile regex pattern once for better performance
    if (options?.referral?.pathPattern) {
      try {
        this.compiledPathPattern = new RegExp(options.referral.pathPattern);
      } catch (error) {
        logger.warn(
          `Invalid referral path pattern: ${options.referral.pathPattern}. Error: ${error}`
        );
      }
    }
  }

  /**
   * Validate an address for both EVM and Solana chains.
   * Uses chainId for strict validation when available.
   * @param address The address to validate
   * @param chainId Optional chain ID for strict chain-specific validation
   * @returns The validated address or null if invalid
   */
  private validateEventAddress(address: string | null | undefined, chainId?: ChainID): Address | null {
    if (!address) {
      return null;
    }
    return validateAddress(address, chainId) || null;
  }
  private getTimezone(): string {
    return getTimezone();
  }

  private getLocation(): string {
    try {
      const timezone = this.getTimezone();
      if (!timezone) return "";
      const mapped = (COUNTRY_LIST as Record<string, string>)[timezone];
      // Only emit ISO-3166 alpha-2. Anything else (including the raw
      // timezone string) is treated as unknown.
      return typeof mapped === "string" && ISO_3166_ALPHA_2_REGEX.test(mapped)
        ? mapped
        : "";
    } catch (error) {
      logger.error("Error resolving location:", error);
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
      logger.error("Error resolving language:", error);
      return "en";
    }
  }

  private getLibraryVersion(): string {
    return version;
  }

  private isExcludedQueryParam(key: string): boolean {
    return this.excludedQueryParams.has(key.toLowerCase());
  }

  /**
   * Normalize URL paths for analytics aggregation by stripping trailing slashes
   * from non-root paths. Query strings and hash fragments are preserved by
   * mutating only the URL pathname.
   */
  private normalizeUrlPath(url: URL): void {
    if (url.pathname !== "/") {
      url.pathname = url.pathname.replace(/\/+$/, "");
    }
  }

  /**
   * Strip excluded (sensitive) query parameters from a URL in place. Only the
   * query string is touched; the path and hash/fragment are left as-is.
   */
  private redactQueryParams(url: URL): void {
    // Collect first, then delete: mutating searchParams while iterating is
    // unsafe, and deleting a key removes all of its values at once.
    const keysToDelete = new Set<string>();
    url.searchParams.forEach((_value, key) => {
      if (this.isExcludedQueryParam(key)) {
        keysToDelete.add(key);
      }
    });
    keysToDelete.forEach((key) => url.searchParams.delete(key));
  }

  /**
   * Return the given absolute URL with excluded query parameters removed and
   * trailing slashes stripped from non-root paths. The input is returned
   * unchanged when it is empty or cannot be parsed (e.g. an empty referrer).
   */
  private redactUrl(href: string): string {
    if (!href) return href;
    try {
      const url = new URL(href);
      this.redactQueryParams(url);
      this.normalizeUrlPath(url);
      return url.href;
    } catch {
      return href;
    }
  }

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
    } catch {}
    return result;
  };

  private extractClickIdParameters = (urlObj: URL): ClickIdParameters => {
    const result = {} as ClickIdParameters;
    for (const param of CLICK_ID_PARAMS) {
      const value = urlObj.searchParams.get(param);
      result[param] = value ? value.trim() : "";
    }
    return result;
  };

  private extractReferralParameter = (urlObj: URL): string => {
    // Strategy: Check query params first, then check path pattern if configured
    // Query params logic:
    // - If no referral config exists → use defaults
    // - If referral config exists but queryParams is undefined → use defaults
    // - If referral config exists with queryParams → use those
    const referralParams = !this.options?.referral
      ? DEFAULT_REFERRAL_PARAMS  // No referral config at all → use defaults
      : (this.options.referral.queryParams ?? DEFAULT_REFERRAL_PARAMS);  // Has config → use queryParams or defaults

    // Check query parameters (if any configured)
    for (const param of referralParams) {
      const value = urlObj.searchParams.get(param)?.trim();
      if (value) return value;
    }

    // Check URL path pattern if configured
    if (this.compiledPathPattern) {
      const pathname = urlObj.pathname;
      const match = pathname.match(this.compiledPathPattern);
      if (match && match[1]) {
        const referralCode = match[1].trim();
        if (referralCode) return referralCode;
      }
    }

    return "";
  };

  /**
   * Returns the document referrer with same-host referrers filtered out.
   * Internal navigation populates `document.referrer` with the previous page
   * on the same site, which is not an attribution signal — treating it as
   * "external" would otherwise let an internal URL become the session's
   * first-touch referrer after a direct landing.
   */
  private getExternalReferrer = (): string => {
    const ref = document.referrer;
    if (!ref) return "";
    try {
      const currentHost = globalThis.location?.hostname;
      if (currentHost && new URL(ref).hostname === currentHost) return "";
    } catch {}
    return this.redactUrl(ref);
  };

  /**
   * Apply the current query-param denylist to a previously-persisted traffic
   * source object. Traffic-source keys (utm_*, click ids, ref) are themselves
   * query-parameter names, so an excluded key's stored value is dropped; the
   * referrer is a URL and is re-redacted. Guards against a stored value
   * outliving the config (or SDK version) under which it was first captured.
   */
  private redactStoredTrafficSources(stored: ITrafficSource): ITrafficSource {
    const result = {} as ITrafficSource;
    for (const key of Object.keys(stored) as (keyof ITrafficSource)[]) {
      const value = stored[key];
      if (key === "referrer") {
        result[key] = this.redactUrl((value as string) || "");
      } else if (this.isExcludedQueryParam(key)) {
        result[key] = "";
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  private getTrafficSources = (url: string): ITrafficSource => {
    const urlObj = new URL(url);
    const contextTrafficSources: ITrafficSource = {
      ...this.extractUTMParameters(url),
      ...this.extractClickIdParameters(urlObj),
      ref: this.extractReferralParameter(urlObj),
      referrer: this.getExternalReferrer(),
    };
    // Sticky traffic sources may have been persisted by an older SDK version or
    // a looser config, before the current excludeQueryParams was in effect.
    // Honor the current denylist on the way out so excluded values can never
    // resurface from session storage (or get re-persisted below).
    const storedTrafficSources = this.redactStoredTrafficSources(
      (session().get(SESSION_TRAFFIC_SOURCE_KEY) as ITrafficSource) || {}
    );

    const mergedClickIds = {} as ClickIdParameters;
    for (const p of CLICK_ID_PARAMS) {
      mergedClickIds[p] =
        contextTrafficSources[p] || storedTrafficSources?.[p] || "";
    }

    const finalTrafficSources: ITrafficSource = {
      ref: contextTrafficSources.ref || storedTrafficSources?.ref || "",
      // Referrer is sticky (first-touch wins). Same-host referrers are already
      // stripped by getExternalReferrer; the stored-first OR keeps the entry
      // referrer pinned even if a later pageview reports a different external
      // referrer (e.g. cross-domain return from an outbound click).
      referrer:
        storedTrafficSources?.referrer || contextTrafficSources.referrer || "",
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
      ...mergedClickIds,
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
  };

  // Get screen dimensions and pixel density
  // Returns safe defaults if any error occurs to ensure event creation continues
  private getScreen(): {
    screen_width: number;
    screen_height: number;
    screen_density: number;
    viewport_width: number;
    viewport_height: number;
  } {
    const safeDefaults = {
      screen_width: 0,
      screen_height: 0,
      screen_density: 1,
      viewport_width: 0,
      viewport_height: 0,
    };

    try {
      return {
        screen_width: globalThis.screen?.width || 0,
        screen_height: globalThis.screen?.height || 0,
        screen_density: globalThis.devicePixelRatio || 1,
        viewport_width: globalThis.innerWidth || 0,
        viewport_height: globalThis.innerHeight || 0,
      };
    } catch (error) {
      logger.error("Error resolving screen properties:", error);
      return safeDefaults;
    }
  }

  // Contextual fields that are automatically collected and populated by the Formo SDK
  private async generateContext(
    context?: IFormoEventContext
  ): Promise<IFormoEventContext> {
    const browserName = await detectBrowser();
    const language = this.getLanguage();
    const timezone = this.getTimezone();
    const location = this.getLocation();
    const library_version = this.getLibraryVersion();

    // Redact once and reuse: traffic-source extraction (utm_*, click ids, ref)
    // must operate on the already-stripped URL too, otherwise an excluded param
    // that happens to be a traffic-source key would still leak via context.
    const redactedHref = this.redactUrl(globalThis.location.href);

    // contextual properties
    const defaultContext = {
      user_agent: globalThis.navigator.userAgent,
      locale: language,
      timezone,
      location,
      ...this.getTrafficSources(redactedHref),
      page_title: document.title,
      page_url: redactedHref,
      library_name: "Formo Web SDK",
      library_version,
      browser: browserName,
      ...this.getScreen(),
    };

    const mergedContext = mergeDeepRight(
      defaultContext,
      context || {}
    ) as IFormoEventContext;

    return mergedContext;
  }

  /**
   * Add any missing default page properties using values from options and defaults
   * @param properties Input page properties
   * @param options API options
   */
  private getPageProperties = (
    properties: IFormoEventProperties
  ): IFormoEventProperties => {
    // Create a copy to avoid mutating the original properties object
    const pageProps = { ...properties };

    // Parse the current URL once and strip any excluded (sensitive) query
    // params up front, so nothing sensitive is forwarded via url, query, or the
    // per-param explosion below. The hash/fragment is intentionally untouched.
    let urlObj: URL | null = null;
    try {
      urlObj = new URL(globalThis.location.href);
      this.redactQueryParams(urlObj);
      this.normalizeUrlPath(urlObj);
    } catch {}

    if (isUndefined(pageProps.url)) {
      pageProps.url = urlObj ? urlObj.href : globalThis.location.href;
    }

    if (isUndefined(pageProps.path)) {
      pageProps.path = urlObj ? urlObj.pathname : globalThis.location.pathname;
    }

    if (isUndefined(pageProps.hash)) {
      pageProps.hash = globalThis.location.hash;
    }

    // Add query string without the '?' prefix
    if (isUndefined(pageProps.query)) {
      pageProps.query = urlObj
        ? urlObj.search.slice(1)
        : globalThis.location.search.slice(1);
    }

    // Parse query parameters and add as individual properties (don't overwrite existing)
    // Skip fields that are already captured in context or are semantic event properties.
    // Excluded params were already removed from urlObj above.
    try {
      if (urlObj) {
        urlObj.searchParams.forEach((value, key) => {
          // Only add if the property doesn't already exist and is not excluded
          if (isUndefined(pageProps[key]) && !PAGE_PROPERTIES_EXCLUDED_FIELDS.has(key)) {
            pageProps[key] = value;
          }
        });
      }
    } catch (error) {
      logger.error("Error parsing query parameters for page properties:", error);
    }

    return pageProps;
  };

  private async getEnrichedEvent(
    formoEvent: Partial<IFormoEvent>,
    context?: IFormoEventContext
  ): Promise<IFormoEvent> {
    const commonEventData = {
      context: await this.generateContext(context),
      original_timestamp: getCurrentTimeFormatted(),
      user_id: formoEvent.user_id,
      type: formoEvent.type,
      channel: CHANNEL,
      version: VERSION,
    } as Partial<IFormoEvent>;

    commonEventData.anonymous_id = generateAnonymousId(LOCAL_ANONYMOUS_ID_KEY, this.options?.crossSubdomainCookies);

    // Handle address - convert undefined to null for consistency
    // Uses chainId for strict chain-specific validation
    const eventChainId = formoEvent.properties?.chainId as ChainID | undefined;
    const validAddress = this.validateEventAddress(formoEvent.address, eventChainId);
    commonEventData.address = validAddress;

    const processedEvent = mergeDeepRight(
      formoEvent,
      commonEventData
    ) as IFormoEvent;

    if (processedEvent.event === undefined) {
      processedEvent.event = null;
    }

    if (processedEvent.properties === undefined) {
      processedEvent.properties = null;
    }

    return toSnakeCase(processedEvent);
  }

  async generatePageEvent(
    category?: string,
    name?: string,
    properties?: IFormoEventProperties,
    context?: IFormoEventContext
  ): Promise<IFormoEvent> {
    // Create a copy to avoid mutating the original properties object
    let props = { ...(properties ?? {}) };
    props.category = category;
    props.name = name;
    props = this.getPageProperties(props);

    const pageEvent: Partial<IFormoEvent> = {
      properties: props,
      type: "page",
    };

    return this.getEnrichedEvent(pageEvent, context);
  }

  async generateDetectWalletEvent(
    providerName: string,
    rdns: string,
    properties?: IFormoEventProperties,
    context?: IFormoEventContext
  ) {
    const detectEvent: Partial<IFormoEvent> = {
      properties: {
        providerName,
        rdns,
        ...properties,
      },
      type: "detect",
    };

    return this.getEnrichedEvent(detectEvent, context);
  }

  async generateIdentifyEvent(
    providerName?: string,
    rdns?: string,
    address?: Nullable<Address>,
    userId?: Nullable<string>,
    properties?: IFormoEventProperties,
    context?: IFormoEventContext
  ) {
    const identifyEvent: Partial<IFormoEvent> = {
      properties: {
        ...(providerName !== undefined && { providerName }),
        ...(rdns !== undefined && { rdns }),
        ...properties,
      },
      user_id: userId,
      address,
      type: "identify",
    };

    return this.getEnrichedEvent(identifyEvent, context);
  }

  async generateConnectEvent(
    chainId: ChainID,
    address: Address,
    properties?: IFormoEventProperties,
    context?: IFormoEventContext
  ) {
    const connectEvent: Partial<IFormoEvent> = {
      properties: {
        chainId,
        ...properties,
      },
      address,
      type: "connect",
    };

    return this.getEnrichedEvent(connectEvent, context);
  }

  async generateDisconnectEvent(
    chainId?: ChainID,
    address?: Address,
    properties?: IFormoEventProperties,
    context?: IFormoEventContext
  ) {
    const disconnectEvent: Partial<IFormoEvent> = {
      properties: {
        chainId,
        ...properties,
      },
      address,
      type: "disconnect",
    };

    return this.getEnrichedEvent(disconnectEvent, context);
  }

  async generateChainChangedEvent(
    chainId: ChainID,
    address: Address,
    properties?: IFormoEventProperties,
    context?: IFormoEventContext
  ) {
    const chainEvent: Partial<IFormoEvent> = {
      properties: {
        chainId,
        ...properties,
      },
      address,
      type: "chain",
    };

    return this.getEnrichedEvent(chainEvent, context);
  }

  async generateSignatureEvent(
    status: SignatureStatus,
    chainId: ChainID,
    address: Address,
    message: string,
    properties?: IFormoEventProperties,
    context?: IFormoEventContext
  ) {
    const signatureEvent: Partial<IFormoEvent> = {
      properties: {
        status,
        chainId,
        message,
        ...properties,
      },
      address,
      type: "signature",
    };

    return this.getEnrichedEvent(signatureEvent, context);
  }

  async generateTransactionEvent(
    status: TransactionStatus,
    chainId: ChainID,
    address: Address,
    data?: string,
    to?: string,
    value?: string,
    transactionHash?: string,
    function_name?: string,
    function_args?: Record<string, unknown>,
    properties?: IFormoEventProperties,
    context?: IFormoEventContext
  ) {
    const transactionEvent: Partial<IFormoEvent> = {
      properties: {
        status,
        chainId,
        ...(data && { data }),
        ...(to && { to }),
        ...(value && { value }),
        ...(transactionHash && { transactionHash }),
        ...(function_name && { function_name }),
        ...(function_args && { function_args }),
        ...properties,
      },
      address,
      type: "transaction",
    };

    return this.getEnrichedEvent(transactionEvent, context);
  }

  async generateTrackEvent(
    event: string,
    properties?: IFormoEventProperties,
    context?: IFormoEventContext
  ) {
    const trackEvent: Partial<IFormoEvent> = {
      properties: {
        ...properties,
        ...(properties?.revenue !== undefined && {
          revenue: Number(properties.revenue),
          currency: (typeof properties?.currency === "string"
            ? properties.currency
            : "USD"
          ).toLowerCase(),
        }),
        ...(properties?.points !== undefined && {
          points: Number(properties.points),
        }),
        ...(properties?.volume !== undefined && {
          volume: Number(properties.volume),
        }),
      },
      event,
      type: "track",
    };

    return this.getEnrichedEvent(trackEvent, context);
  }

  // Returns an event with type, context, properties, and common properties
  async create(
    event: APIEvent,
    address?: Address,
    userId?: string
  ): Promise<IFormoEvent> {
    let formoEvent: Partial<IFormoEvent> = {};

    switch (event.type) {
      case "page":
        formoEvent = await this.generatePageEvent(
          event.category,
          event.name,
          event.properties,
          event.context
        );
        break;
      case "detect":
        formoEvent = await this.generateDetectWalletEvent(
          event.providerName,
          event.rdns,
          event.properties,
          event.context
        );
        break;
      case "identify":
        formoEvent = await this.generateIdentifyEvent(
          event.providerName,
          event.rdns,
          event.address,
          event.userId,
          event.properties,
          event.context
        );
        break;
      case "chain":
        formoEvent = await this.generateChainChangedEvent(
          event.chainId,
          event.address,
          event.properties,
          event.context
        );
        break;
      case "connect":
        formoEvent = await this.generateConnectEvent(
          event.chainId,
          event.address,
          event.properties,
          event.context
        );
        break;
      case "disconnect":
        formoEvent = await this.generateDisconnectEvent(
          event.chainId,
          event.address,
          event.properties,
          event.context
        );
        break;
      case "signature":
        formoEvent = await this.generateSignatureEvent(
          event.status,
          event.chainId,
          event.address,
          event.message,
          event.properties,
          event.context
        );
        break;
      case "transaction":
        formoEvent = await this.generateTransactionEvent(
          event.status,
          event.chainId,
          event.address,
          event.data,
          event.to,
          event.value,
          event.transactionHash,
          event.function_name,
          event.function_args,
          event.properties,
          event.context
        );
        break;
      case "track":
      default:
        formoEvent = await this.generateTrackEvent(
          event.event,
          event.properties,
          event.context
        );
        break;
    }

    // Set address if not already set by the specific event generator
    // Uses chainId for strict chain-specific validation
    // Skip backfill for identify events to prevent stale address being used
    if (
      (formoEvent.address === undefined || formoEvent.address === null) &&
      event.type !== "identify"
    ) {
      const chainId = 'chainId' in event ? (event.chainId as ChainID) : undefined;
      formoEvent.address = this.validateEventAddress(address, chainId);
    }
    // An identify event asserts an explicit identity in its own payload (e.g. a
    // Privy DID for each wallet being clustered). Keep that payload user_id
    // rather than overwriting it with the active-session user id — otherwise a
    // clustering identify that intentionally leaves the active user unchanged
    // (setActive:false) would be stripped of its DID, defeating server-side
    // wallet clustering. Fall back to the active-session user id when the
    // identify payload carries none; all other events use the session user id.
    formoEvent.user_id =
      event.type === "identify"
        ? formoEvent.user_id ?? userId ?? null
        : userId || null;

    return formoEvent as IFormoEvent;
  }
}

export { EventFactory };
