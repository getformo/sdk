import { COUNTRY_LIST } from "../../constants";
import {
  Address,
  APIEvent,
  ChainID,
  IFormoEvent,
  IFormoEventContext,
  IFormoEventProperties,
  Nullable,
  SignatureStatus,
  TransactionStatus,
  UTMParameters,
} from "../../types";
import {
  generateNativeUUID,
  toChecksumAddress,
  toSnakeCase,
} from "../../utils";
import { getCurrentTimeFormatted } from "../../utils/timestamp";
import { isUndefined } from "../../validators";
import { logger } from "../logger";
import mergeDeepRight from "../ramda/mergeDeepRight";
import { local } from "../storage";
import { version } from "../version";
import { CHANNEL, VERSION } from "./constants";
import { IEventFactory } from "./type";
import { generateAnonymousId } from "./utils";

class EventFactory implements IEventFactory {
  constructor() {}

  private getTimezone(): string {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch (error) {
      logger.error("Error resolving timezone:", error);
      return "";
    }
  }

  private getLocation(): string | undefined {
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

  private extractUTMParameters = (url: string): UTMParameters => {
    const result: UTMParameters = {};
    try {
      const urlObj = new URL(url);
      const UTM_PREFIX = "utm_";
      urlObj.searchParams.forEach((value, sParam) => {
        if (sParam.startsWith(UTM_PREFIX)) {
          result[sParam] = value.trim() || "";
        }
      });
    } catch (error) {}
    return result;
  };

  // Contextual fields that are automatically collected and populated by the Formo SDK
  private generateContext(context?: IFormoEventContext): IFormoEventContext {
    const url = new URL(globalThis.location.href);
    const params = new URLSearchParams(url.search);
    const path = globalThis.location.pathname;
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
      referrer: document.referrer,
      ...this.extractUTMParameters(globalThis.location.href),
      ref: params.get("ref")?.trim() || "",
      page_path: path,
      page_title: document.title,
      page_url: url.href,
      library_name: "Formo Web SDK",
      library_version,
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

  private getEnrichedEvent = (
    formoEvent: Partial<IFormoEvent>,
    context?: IFormoEventContext
  ): IFormoEvent => {
    const commonEventData = {
      context: this.generateContext(context),
      original_timestamp: getCurrentTimeFormatted(),
      user_id: formoEvent.user_id,
      type: formoEvent.type,
      channel: CHANNEL,
      version: VERSION,
    } as Partial<IFormoEvent>;

    if (!local.isAvailable()) {
      commonEventData.anonymous_id = generateNativeUUID();
    } else {
      commonEventData.anonymous_id = generateAnonymousId();
    }

    if (formoEvent.address) {
      commonEventData.address = toChecksumAddress(formoEvent.address);
    } else {
      commonEventData.address = formoEvent.address;
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
  };

  generatePageEvent(
    category?: string,
    name?: string,
    properties?: IFormoEventProperties,
    context?: IFormoEventContext
  ): IFormoEvent {
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

  generateDetectWalletEvent(
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

  generateIdentifyEvent(
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

  generateConnectEvent(
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

  generateDisconnectEvent(
    chainId: ChainID,
    address: Address,
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

  generateChainChangedEvent(
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

  generateSignatureEvent(
    status: SignatureStatus,
    chainId: ChainID,
    address: Address,
    message: string,
    signatureHash: string,
    properties?: IFormoEventProperties,
    context?: IFormoEventContext
  ) {
    const signatureEvent: Partial<IFormoEvent> = {
      properties: {
        status,
        chainId,
        message,
        signatureHash,
        ...properties,
      },
      address,
      type: "signature",
    };

    return this.getEnrichedEvent(signatureEvent, context);
  }

  generateTransactionEvent(
    status: TransactionStatus,
    chainId: ChainID,
    address: Address,
    data: string,
    to: string,
    value: string,
    transactionHash: string,
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
        transactionHash,
        ...properties,
      },
      address,
      type: "transaction",
    };

    return this.getEnrichedEvent(transactionEvent, context);
  }

  generateTrackEvent(
    event: string,
    properties?: IFormoEventProperties,
    context?: IFormoEventContext
  ) {
    const transactionEvent: Partial<IFormoEvent> = {
      properties,
      event,
      type: "track",
    };

    return this.getEnrichedEvent(transactionEvent, context);
  }

  // Returns an event with type, context, properties, and common properties
  create(event: APIEvent, address?: Address, userId?: string): IFormoEvent {
    let formoEvent: Partial<IFormoEvent> = {};

    formoEvent.address = address || null;
    formoEvent.user_id = userId || null;

    switch (event.type) {
      case "page":
        formoEvent = this.generatePageEvent(
          event.category,
          event.name,
          event.properties,
          event.context
        );
        break;
      case "detect":
        formoEvent = this.generateDetectWalletEvent(
          event.providerName,
          event.rdns,
          event.properties,
          event.context
        );
        break;
      case "identify":
        formoEvent = this.generateIdentifyEvent(
          event.providerName,
          event.rdns,
          event.address,
          event.userId,
          event.properties,
          event.context
        );
        break;
      case "chain":
        formoEvent = this.generateChainChangedEvent(
          event.chainId,
          event.address,
          event.properties,
          event.context
        );
        break;
      case "connect":
        formoEvent = this.generateConnectEvent(
          event.chainId,
          event.address,
          event.properties,
          event.context
        );
        break;
      case "disconnect":
        formoEvent = this.generateDisconnectEvent(
          event.chainId,
          event.address,
          event.properties,
          event.context
        );
        break;
      case "signature":
        formoEvent = this.generateSignatureEvent(
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
        formoEvent = this.generateTransactionEvent(
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
        formoEvent = this.generateTrackEvent(
          event.event,
          event.properties,
          event.context
        );
        break;
    }
    return formoEvent as IFormoEvent;
  }
}

export { EventFactory };
