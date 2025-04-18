import { Address, ChainID, SignatureStatus, TransactionStatus } from "../types";
import { Event, COUNTRY_LIST } from "../constants";

export class EventFactory {
  private static buildBrowserPayload(): Record<string, unknown> {
    const url = new URL(window.location.href);
    const params = new URLSearchParams(url.search);

    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const location = timezone in COUNTRY_LIST
      ? COUNTRY_LIST[timezone as keyof typeof COUNTRY_LIST]
      : timezone;

    const language = (navigator.languages && navigator.languages.length
      ? navigator.languages[0]
      : navigator.language) || "en";

    return {
      user_agent: window.navigator.userAgent,
      href: url.href,
      locale: language,
      location,
      referrer: document.referrer,
      utm_source: params.get("utm_source"),
      utm_medium: params.get("utm_medium"),
      utm_campaign: params.get("utm_campaign"),
      utm_content: params.get("utm_content"),
      utm_term: params.get("utm_term"),
      ref: params.get("ref"),
    };
  }

  static buildPagePayload(): Record<string, unknown> {
    return {
      ...this.buildBrowserPayload(),
      pathname: window.location.pathname,
      hash: window.location.hash,
    };
  }

  static buildConnectPayload(chainId: ChainID, address: Address): Record<string, unknown> {
    return {
      ...this.buildBrowserPayload(),
      chain_id: chainId,
      address,
    };
  }

  static buildDisconnectPayload(chainId?: ChainID, address?: Address): Record<string, unknown> {
    return {
      ...this.buildBrowserPayload(),
      chain_id: chainId,
      address,
    };
  }

  static buildChainChangedPayload(chainId: ChainID, address: Address): Record<string, unknown> {
    return {
      ...this.buildBrowserPayload(),
      chain_id: chainId,
      address,
    };
  }

  static buildSignaturePayload(
    status: SignatureStatus,
    chainId: ChainID,
    address: Address,
    message: string,
    signatureHash?: string
  ): Record<string, unknown> {
    return {
      ...this.buildBrowserPayload(),
      status,
      chain_id: chainId,
      address,
      message,
      ...(signatureHash && { signature_hash: signatureHash }),
    };
  }

  static buildTransactionPayload(
    status: TransactionStatus,
    chainId: ChainID,
    address: Address,
    data?: string,
    to?: string,
    value?: string,
    transactionHash?: string
  ): Record<string, unknown> {
    return {
      ...this.buildBrowserPayload(),
      status,
      chain_id: chainId,
      address,
      data,
      to,
      value,
      ...(transactionHash && { transaction_hash: transactionHash }),
    };
  }

  static buildIdentifyPayload(
    address: Address | null,
    providerName?: string,
    rdns?: string
  ): Record<string, unknown> {
    return {
      ...this.buildBrowserPayload(),
      address,
      provider_name: providerName,
      rdns,
    };
  }
}
