import { Platform, NativeModules, Dimensions } from "react-native";
import { COUNTRY_LIST, LOCAL_ANONYMOUS_ID_KEY, CHANNEL, VERSION } from "../../constants";
import {
  Address,
  APIEvent,
  ChainID,
  IFormoEvent,
  IFormoEventContext,
  IFormoEventProperties,
  Nullable,
  Options,
  SignatureStatus,
  TransactionStatus,
} from "../../types";
import {
  toChecksumAddress,
  getValidAddress,
  toSnakeCase,
  mergeDeepRight,
  isUndefined,
} from "../../utils";
import { getCurrentTimeFormatted } from "../../utils/timestamp";
import { generateUUID } from "../../utils/hash";
import { logger } from "../logger";
import { storage } from "../storage";
import { IEventFactory } from "./types";

// SDK version
const SDK_VERSION = "1.0.0";

/**
 * Generate or retrieve anonymous ID
 */
function generateAnonymousId(key: string): string {
  const existing = storage().get(key);
  if (existing) {
    return existing;
  }

  const newId = generateUUID();
  storage().set(key, newId);
  return newId;
}

/**
 * Event factory for React Native
 * Creates event payloads with mobile-specific context
 */
class EventFactory implements IEventFactory {
  private options?: Options;

  constructor(options?: Options) {
    this.options = options;
  }

  /**
   * Get device timezone
   */
  private getTimezone(): string {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch (error) {
      logger.error("Error resolving timezone:", error);
      return "";
    }
  }

  /**
   * Get location from timezone
   */
  private getLocation(): string {
    try {
      const timezone = this.getTimezone();
      if (timezone in COUNTRY_LIST) {
        return COUNTRY_LIST[timezone] ?? timezone;
      }
      return timezone;
    } catch (error) {
      logger.error("Error resolving location:", error);
      return "";
    }
  }

  /**
   * Get device language/locale
   */
  private getLanguage(): string {
    try {
      // Try to get the device locale
      const locale =
        Platform.OS === "ios"
          ? NativeModules.SettingsManager?.settings?.AppleLocale ||
            NativeModules.SettingsManager?.settings?.AppleLanguages?.[0]
          : NativeModules.I18nManager?.localeIdentifier;

      return locale || "en";
    } catch (error) {
      logger.debug("Error resolving language:", error);
      return "en";
    }
  }

  /**
   * Get screen dimensions
   */
  private getScreen(): {
    screen_width: number;
    screen_height: number;
    screen_density: number;
  } {
    try {
      const { width, height, scale } = Dimensions.get("screen");
      return {
        screen_width: Math.round(width),
        screen_height: Math.round(height),
        screen_density: scale,
      };
    } catch (error) {
      logger.error("Error resolving screen properties:", error);
      return {
        screen_width: 0,
        screen_height: 0,
        screen_density: 1,
      };
    }
  }

  /**
   * Get device information
   */
  private getDeviceInfo(): {
    os_name: string;
    os_version: string;
    device_model: string;
    device_type: string;
  } {
    try {
      return {
        os_name: Platform.OS,
        os_version: String(Platform.Version),
        device_model: Platform.select({ ios: "iOS Device", android: "Android Device" }) || "Unknown",
        device_type: "mobile",
      };
    } catch (error) {
      logger.error("Error getting device info:", error);
      return {
        os_name: "unknown",
        os_version: "unknown",
        device_model: "unknown",
        device_type: "mobile",
      };
    }
  }

  /**
   * Generate context with mobile-specific metadata
   */
  private async generateContext(
    context?: IFormoEventContext
  ): Promise<IFormoEventContext> {
    const language = this.getLanguage();
    const timezone = this.getTimezone();
    const location = this.getLocation();
    const deviceInfo = this.getDeviceInfo();
    const screenInfo = this.getScreen();

    const defaultContext: IFormoEventContext = {
      locale: language,
      timezone,
      location,
      library_name: "Formo React Native SDK",
      library_version: SDK_VERSION,
      ...deviceInfo,
      ...screenInfo,
      // App info from options
      ...(this.options?.app && {
        app_name: this.options.app.name,
        app_version: this.options.app.version,
        app_build: this.options.app.build,
        app_bundle_id: this.options.app.bundleId,
      }),
    };

    const mergedContext = mergeDeepRight(
      defaultContext,
      context || {}
    ) as IFormoEventContext;

    return mergedContext;
  }

  /**
   * Create enriched event with common properties
   */
  private async getEnrichedEvent(
    formoEvent: Partial<IFormoEvent>,
    context?: IFormoEventContext
  ): Promise<IFormoEvent> {
    const commonEventData: Partial<IFormoEvent> = {
      context: await this.generateContext(context),
      original_timestamp: getCurrentTimeFormatted(),
      user_id: formoEvent.user_id,
      type: formoEvent.type,
      channel: CHANNEL,
      version: VERSION,
    };

    commonEventData.anonymous_id = generateAnonymousId(LOCAL_ANONYMOUS_ID_KEY);

    // Handle address - convert undefined to null for consistency
    const validAddress = getValidAddress(formoEvent.address);
    if (validAddress) {
      commonEventData.address = toChecksumAddress(validAddress);
    } else {
      commonEventData.address = null;
    }

    const processedEvent = mergeDeepRight(
      formoEvent as Record<string, unknown>,
      commonEventData as Record<string, unknown>
    ) as unknown as IFormoEvent;

    if (processedEvent.event === undefined) {
      processedEvent.event = null;
    }

    if (processedEvent.properties === undefined) {
      processedEvent.properties = null;
    }

    return toSnakeCase(processedEvent);
  }

  /**
   * Generate screen view event (mobile equivalent of page)
   */
  async generateScreenEvent(
    name: string,
    properties?: IFormoEventProperties,
    context?: IFormoEventContext
  ): Promise<IFormoEvent> {
    const props = { ...(properties ?? {}), name };

    const screenEvent: Partial<IFormoEvent> = {
      properties: props,
      type: "screen",
    };

    return this.getEnrichedEvent(screenEvent, context);
  }

  async generateDetectWalletEvent(
    providerName: string,
    rdns: string,
    properties?: IFormoEventProperties,
    context?: IFormoEventContext
  ): Promise<IFormoEvent> {
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
  ): Promise<IFormoEvent> {
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
  ): Promise<IFormoEvent> {
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
  ): Promise<IFormoEvent> {
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
  ): Promise<IFormoEvent> {
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
  ): Promise<IFormoEvent> {
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
  ): Promise<IFormoEvent> {
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
  ): Promise<IFormoEvent> {
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

  /**
   * Create event from API event type
   */
  async create(
    event: APIEvent,
    address?: Address,
    userId?: string
  ): Promise<IFormoEvent> {
    let formoEvent: Partial<IFormoEvent> = {};

    switch (event.type) {
      case "screen":
        formoEvent = await this.generateScreenEvent(
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
