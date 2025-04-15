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

class EventFactory implements IEventFactory {
  constructor() {}

  private getLocation(): string | undefined {
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (timezone in COUNTRY_LIST)
        return COUNTRY_LIST[timezone as keyof typeof COUNTRY_LIST];
      return timezone;
    } catch (error) {
      logger.error("Error resolving timezone:", error);
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
      version: "1",
    };
  }

  private buildCommonPayload() {
    const url = new URL(window.location.href);

    const location = this.getLocation();
    const language = this.getLanguage();

    // common properties
    return {
      "user-agent": window.navigator.userAgent,
      href: url.href,
      locale: language,
      location,
    };
  }

  generatePageEvent() {
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

  generateCustomEvent(args: any) {
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
    const payload = this.buildCommonPayload();
    let eventSpecificPayload = this.generateCustomEvent(event);
    if (event.action === "page_hit") {
      eventSpecificPayload = this.generatePageEvent();
    }
    if (event.action === "connect") {
      eventSpecificPayload = this.generateConnectEvent(
        event.chainId,
        event.address
      );
    }
    if (event.action === "disconnect") {
      eventSpecificPayload = this.generateDisconnectEvent(
        event.chainId,
        event.address
      );
    }
    if (event.action === "detect_wallet") {
      eventSpecificPayload = this.generateDetectWalletEvent(
        event.providerName,
        event.rdns
      );
    }
    if (event.action === "identify") {
      eventSpecificPayload = this.generateIdentifyEvent(
        event.address,
        event.providerName,
        event.rdns
      );
    }
    if (event.action === "chain_changed") {
      eventSpecificPayload = this.generateChainChangedEvent(
        event.chainId,
        event.address
      );
    }
    if (event.action === "signature") {
      eventSpecificPayload = this.generateSignatureEvent(
        event.status,
        event.chainId,
        event.address,
        event.message,
        event.signatureHash
      );
    }
    if (event.action === "transaction") {
      eventSpecificPayload = this.generateTransactionEvent(
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
        payload: {
          ...payload,
          ...eventSpecificPayload,
        },
      },
      ["user-agent"]
    );
  }
}

export { EventFactory };
