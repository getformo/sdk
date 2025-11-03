import {
  COUNTRY_LIST,
  LOCAL_ANONYMOUS_ID_KEY,
  SESSION_TRAFFIC_SOURCE_KEY,
} from "../../constants";
import {
  Address,
  APIEvent,
  ChainID,
  IFormoEvent,
  IFormoEventContext,
  IFormoEventProperties,
  ITrafficSource,
  Nullable,
  SignatureStatus,
  TransactionStatus,
} from "../../types";
import { toChecksumAddress, toSnakeCase } from "../../utils";
import { getValidAddress } from "../../utils/address";
import { getCurrentTimeFormatted } from "../../utils/timestamp";
import { isUndefined } from "../../validators";
import { logger } from "../logger";
import mergeDeepRight from "../ramda/mergeDeepRight";
import { session } from "../storage";
import { version } from "../version";
import { CHANNEL, VERSION } from "./constants";
import { IEventFactory } from "./type";
import { generateAnonymousId } from "./utils";
import { detectBrowser } from "../browser/browsers";

class EventFactory implements IEventFactory {
  private getTimezone(): string {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch (error) {
      logger.error("Error resolving timezone:", error);
      return "";
    }
  }

  private getLocation(): string {
    try {
      const timezone = this.getTimezone();
      if (timezone in COUNTRY_LIST)
        return COUNTRY_LIST[timezone as keyof typeof COUNTRY_LIST];
      return timezone;
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

  /**
   * Retrieves stored traffic sources from session storage
   * Traffic sources are parsed and stored during initialization
   */
  private getTrafficSources = (): ITrafficSource => {
    const stored = session().get(SESSION_TRAFFIC_SOURCE_KEY) as ITrafficSource;
    if (stored) {
      return stored;
    }
    // Return defaults if nothing stored (shouldn't happen after init, but safe fallback)
    return {
      ref: "",
      referrer: document.referrer || "",
      utm_campaign: "",
      utm_content: "",
      utm_medium: "",
      utm_source: "",
      utm_term: "",
    };
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
    const path = globalThis.location.pathname;
    const browserName = await detectBrowser();
    const language = this.getLanguage();
    const timezone = this.getTimezone();
    const location = this.getLocation();
    const library_version = this.getLibraryVersion();

    // contextual properties
    const defaultContext = {
      user_agent: globalThis.navigator.userAgent,
      locale: language,
      timezone,
      location,
      ...this.getTrafficSources(),
      page_path: path,
      page_title: document.title,
      page_url: globalThis.location.href,
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
    const pageProps = properties;

    if (isUndefined(pageProps.url)) {
      pageProps.url = new URL(globalThis.location.href).href;
    }

    if (isUndefined(pageProps.path)) {
      pageProps.path = globalThis.location.pathname;
    }

    if (isUndefined(pageProps.hash)) {
      pageProps.hash = globalThis.location.hash;
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

    commonEventData.anonymous_id = generateAnonymousId(LOCAL_ANONYMOUS_ID_KEY);

    // Handle address - convert undefined to null for consistency
    const validAddress = getValidAddress(formoEvent.address);
    if (validAddress) {
      commonEventData.address = toChecksumAddress(validAddress);
    } else {
      commonEventData.address = null;
    }

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
    let props = properties ?? {};
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
    providerName: string,
    rdns: string,
    address: Nullable<Address>,
    userId?: Nullable<string>,
    properties?: IFormoEventProperties,
    context?: IFormoEventContext
  ) {
    const identifyEvent: Partial<IFormoEvent> = {
      properties: {
        providerName,
        rdns,
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
    signatureHash?: string,
    properties?: IFormoEventProperties,
    context?: IFormoEventContext
  ) {
    const signatureEvent: Partial<IFormoEvent> = {
      properties: {
        status,
        chainId,
        message,
        ...(signatureHash && { signatureHash }),
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
    data: string,
    to: string,
    value: string,
    transactionHash?: string,
    properties?: IFormoEventProperties,
    context?: IFormoEventContext
  ) {
    const transactionEvent: Partial<IFormoEvent> = {
      properties: {
        status,
        chainId,
        data,
        to,
        value,
        ...(transactionHash && { transactionHash }),
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
          event.signatureHash,
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
    if (formoEvent.address === undefined || formoEvent.address === null) {
      const validAddress = getValidAddress(address);
      formoEvent.address = validAddress
        ? toChecksumAddress(validAddress)
        : null;
    }
    formoEvent.user_id = userId || null;

    return formoEvent as IFormoEvent;
  }
}

export { EventFactory };
