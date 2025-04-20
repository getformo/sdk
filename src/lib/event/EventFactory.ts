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

  private buildCommonProperties(
    anonymous_id: UUID,
    user_id: string | null,
    address: string | null,
    action: string
  ) {
    // common properties
    return {
      anonymous_id,
      user_id,
      address: address && toChecksumAddress(address),
      timestamp: new Date().toISOString(),
      action,
      channel: "web",
      version: "2",
    };
  }

  // Contextual fields that are automatically collected and populated by the Formo SDK
  private buildContext() {
    const url = new URL(window.location.href);
    const params = new URLSearchParams(url.search);
    const page_path = window.location.pathname;
    const page_title = document.title;
    const page_url = url.href;
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
      utm_source: params.get("utm_source")?.trim() || "",
      utm_medium: params.get("utm_medium")?.trim() || "",
      utm_campaign: params.get("utm_campaign")?.trim() || "",
      utm_content: params.get("utm_content")?.trim() || "",
      utm_term: params.get("utm_term")?.trim() || "",
      ref: params.get("ref")?.trim() || "",
      page_path,
      page_title,
      page_url,
      library_name: "Formo Web SDK",
      library_version: SDK_VERSION,
    };
  }

  buildPageEvent() {
    const url = new URL(window.location.href);
    const params = new URLSearchParams(url.search);
    const pathname = window.location.pathname;
    const hash = window.location.hash;

    return {
      pathname: pathname || url.pathname,
      hash: hash || url.hash,
      referrer: document.referrer,
      utm_source: params.get("utm_source")?.trim() || "",
      utm_medium: params.get("utm_medium")?.trim() || "",
      utm_campaign: params.get("utm_campaign")?.trim() || "",
      utm_content: params.get("utm_content")?.trim() || "",
      utm_term: params.get("utm_term")?.trim() || "",
      ref: params.get("ref")?.trim() || "",
    };
  }

  buildConnectEvent(chainId: ChainID, address: Address) {
    return {
      chainId,
      address,
    };
  }

  buildDisconnectEvent(chainId: ChainID, address: Address) {
    return {
      chainId,
      address,
    };
  }

  buildDetectWalletEvent(providerName: string, rdns: string) {
    return {
      providerName,
      rdns,
    };
  }

  buildIdentifyEvent(
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

  buildChainChangedEvent(chainId: ChainID, address: Address) {
    return {
      chainId,
      address,
    };
  }

  buildSignatureEvent(
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

  buildTransactionEvent(
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

  buildCustomEvent(args: any) {
    if (typeof args !== "object") {
      logger.warn("Invalid event data");
      return {};
    }
    const { action, ...rest } = args;

    return {
      ...rest,
    };
  }

  create(
    anonymous_id: UUID,
    user_id: string | null,
    address: string | null,
    event: APIEvent
  ) {
    const commonProperties = this.buildCommonProperties(
      anonymous_id,
      user_id,
      address,
      event.action
    );
    const context = this.buildContext();
    let payload = this.buildCustomEvent(event);
    if (event.action === "page_hit") {
      payload = this.buildPageEvent();
    }
    if (event.action === "connect") {
      payload = this.buildConnectEvent(
        event.chainId,
        event.address
      );
    }
    if (event.action === "disconnect") {
      payload = this.buildDisconnectEvent(
        event.chainId,
        event.address
      );
    }
    if (event.action === "detect_wallet") {
      payload = this.buildDetectWalletEvent(
        event.providerName,
        event.rdns
      );
    }
    if (event.action === "identify") {
      payload = this.buildIdentifyEvent(
        event.address,
        event.providerName,
        event.rdns
      );
    }
    if (event.action === "chain_changed") {
      payload = this.buildChainChangedEvent(
        event.chainId,
        event.address
      );
    }
    if (event.action === "signature") {
      payload = this.buildSignatureEvent(
        event.status,
        event.chainId,
        event.address,
        event.message,
        event.signatureHash
      );
    }
    if (event.action === "transaction") {
      payload = this.buildTransactionEvent(
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
        payload,
      }
    );
  }
}

export { EventFactory };
