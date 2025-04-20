import { UUID } from "crypto";
import { COUNTRY_LIST } from "../../constants";
import {
  Address,
  APIEvent,
  ChainID,
  SignatureStatus,
  TransactionStatus,
} from "../../types";
import { logger } from "../logger";
import { IEventFactory } from "./type";
import { toChecksumAddress, toSnakeCase } from "../../utils";
import { SDK_VERSION } from "../../constants";

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

  private generateCommonProperties(
    anonymous_id: UUID,
    user_id: string | null,
    address: string | null,
    type: string
  ) {
    // common properties
    return {
      anonymous_id,
      user_id,
      address: address && toChecksumAddress(address),
      timestamp: new Date().toISOString(),
      type,
      channel: "web",
      version: "2",
    };
  }

  // Contextual fields that are automatically collected and populated by the Formo SDK
  private generateContext() {
    const url = new URL(window.location.href);
    const params = new URLSearchParams(url.search);
    const path = window.location.pathname;
    const language = this.getLanguage();
    const timezone = this.getTimezone();
    const location = this.getLocation();

    // contextual properties
    return {
      "user_agent": window.navigator.userAgent,
      href: url.href,
      locale: language,
      timezone,
      location,
      referrer: document.referrer,
      utm_source: params.get("utm_source")?.trim() || "",
      utm_medium: params.get("utm_medium")?.trim() || "",
      utm_campaign: params.get("utm_campaign")?.trim() || "",
      utm_content: params.get("utm_content")?.trim() || "",
      utm_term: params.get("utm_term")?.trim() || "",
      ref: params.get("ref")?.trim() || "",
      page_path: path,
      page_title: document.title,
      page_url: url.href,
      library_name: "Formo Web SDK",
      library_version: SDK_VERSION,
    };
  }

  generatePageEvent() {
    const url = new URL(window.location.href);
    const path = window.location.pathname;
    const hash = window.location.hash;

    return {
      path: path || url.pathname,
      url: url.href,
      title: document.title,
      hash: hash || url.hash
    };
  }

  generateConnectEvent(chainId: ChainID, address: Address) {
    return {
      chainId,
      address,
    };
  }

  generateDisconnectEvent(chainId: ChainID, address: Address) {
    return {
      chainId,
      address,
    };
  }

  generateDetectWalletEvent(providerName: string, rdns: string) {
    return {
      providerName,
      rdns,
    };
  }

  generateIdentifyEvent(
    address: Address | null,
    providerName: string,
    rdns: string
  ) {
    return {
      address,
      providerName,
      rdns,
    };
  }

  generateChainChangedEvent(chainId: ChainID, address: Address) {
    return {
      chainId,
      address,
    };
  }

  generateSignatureEvent(
    status: SignatureStatus,
    chainId: ChainID,
    address: Address,
    message: string,
    signatureHash: string
  ) {
    return {
      status,
      chainId,
      address,
      message,
      signatureHash,
    };
  }

  generateTransactionEvent(
    status: TransactionStatus,
    chainId: ChainID,
    address: Address,
    data: string,
    to: string,
    value: string,
    transactionHash: string
  ) {
    return {
      status,
      chainId,
      address,
      data,
      to,
      value,
      transactionHash,
    };
  }

  create(
    anonymous_id: UUID,
    user_id: string | null,
    address: string | null,
    event: APIEvent
  ) {
    const commonProperties = this.generateCommonProperties(
      anonymous_id,
      user_id,
      address,
      event.type
    );
    const context = this.generateContext();
    let properties;
    if (event.type === "page_hit") {
      properties = this.generatePageEvent();
    }
    if (event.type === "connect") {
      properties = this.generateConnectEvent(
        event.chainId,
        event.address
      );
    }
    if (event.type === "disconnect") {
      properties = this.generateDisconnectEvent(
        event.chainId,
        event.address
      );
    }
    if (event.type === "detect_wallet") {
      properties = this.generateDetectWalletEvent(
        event.providerName,
        event.rdns
      );
    }
    if (event.type === "identify") {
      properties = this.generateIdentifyEvent(
        event.address,
        event.providerName,
        event.rdns
      );
    }
    if (event.type === "chain_changed") {
      properties = this.generateChainChangedEvent(
        event.chainId,
        event.address
      );
    }
    if (event.type === "signature") {
      properties = this.generateSignatureEvent(
        event.status,
        event.chainId,
        event.address,
        event.message,
        event.signatureHash
      );
    }
    if (event.type === "transaction") {
      properties = this.generateTransactionEvent(
        event.status,
        event.chainId,
        event.address,
        event.data,
        event.to,
        event.value,
        event.transactionHash
      );
    }

    return toSnakeCase(
      {
        ...commonProperties,
        context,
        properties,
      }
    );
  }
}

export { EventFactory };
