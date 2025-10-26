import { LogLevel } from "../lib";
import {
  IFormoEventContext,
  IFormoEventProperties,
  SignatureStatus,
  TransactionStatus,
} from "./events";
import { EIP1193Provider } from "./provider";
import { ReactNode } from "react";

export type Nullable<T> = T | null;
// Decimal chain ID
export type ChainID = number;

// Address (EVM, Solana, etc.)
export type Address = string;

export type ValidInputTypes = Uint8Array | bigint | string | number | boolean;
export interface IFormoAnalytics {
  page(
    category?: string,
    name?: string,
    properties?: IFormoEventProperties,
    context?: IFormoEventContext,
    callback?: (...args: unknown[]) => void
  ): Promise<void>;
  reset(): void;
  detect(
    params: { rdns: string; providerName: string },
    properties?: IFormoEventProperties,
    context?: IFormoEventContext,
    callback?: (...args: unknown[]) => void
  ): Promise<void>;
  connect(
    params: { chainId: ChainID; address: Address },
    properties?: IFormoEventProperties,
    context?: IFormoEventContext,
    callback?: (...args: unknown[]) => void
  ): Promise<void>;
  disconnect(
    params: { chainId?: ChainID; address?: Address },
    properties?: IFormoEventProperties,
    context?: IFormoEventContext,
    callback?: (...args: unknown[]) => void
  ): Promise<void>;
  chain(
    params: { chainId: ChainID; address?: Address },
    properties?: IFormoEventProperties,
    context?: IFormoEventContext,
    callback?: (...args: unknown[]) => void
  ): Promise<void>;
  signature(
    params: {
      status: SignatureStatus;
      chainId?: ChainID;
      address: Address;
      message: string;
      signatureHash?: string;
    },
    properties?: IFormoEventProperties,
    context?: IFormoEventContext,
    callback?: (...args: unknown[]) => void
  ): Promise<void>;
  transaction(
    params: {
      status: TransactionStatus;
      chainId: ChainID;
      address: Address;
      data?: string;
      to?: string;
      value?: string;
      transactionHash?: string;
    },
    properties?: IFormoEventProperties,
    context?: IFormoEventContext,
    callback?: (...args: unknown[]) => void
  ): Promise<void>;
  identify(
    params: {
      address: Address;
      providerName?: string;
      userId?: string;
      rdns?: string;
    },
    properties?: IFormoEventProperties,
    context?: IFormoEventContext,
    callback?: (...args: unknown[]) => void
  ): Promise<void>;
  track(
    event: string,
    properties?: IFormoEventProperties,
    context?: IFormoEventContext,
    callback?: (...args: unknown[]) => void
  ): Promise<void>;
  
  // Consent management methods
  optOutTracking(): void;
  optInTracking(): void;
  hasOptedOutTracking(): boolean;
}

export interface Config {
  writeKey: string;
}

/**
 * Configuration options for controlling tracking exclusions
 */
export interface TrackingOptions {
  excludeHosts?: string[];
  excludePaths?: string[];
  excludeChains?: ChainID[];
}

/**
 * Configuration options for controlling wallet event autocapture
 */
export interface AutocaptureOptions {
  /**
   * Enable/disable all wallet event autocapture
   * When false, no wallet events are tracked and no listeners are registered
   * @default true
   */
  enabled?: boolean;
  
  /**
   * Control which specific wallet events are tracked
   * All events are enabled by default unless explicitly set to false
   */
  events?: {
    /**
     * Track wallet connect events
     * @default true
     */
    connect?: boolean;
    
    /**
     * Track wallet disconnect events
     * @default true
     */
    disconnect?: boolean;
    
    /**
     * Track wallet signature events (personal_sign, eth_signTypedData_v4)
     * @default true
     */
    signature?: boolean;
    
    /**
     * Track wallet transaction events (eth_sendTransaction)
     * @default true
     */
    transaction?: boolean;
    
    /**
     * Track wallet chain change events
     * @default true
     */
    chain?: boolean;
  };
}


export interface Options {
  provider?: EIP1193Provider;
  tracking?: boolean | TrackingOptions;
  autocapture?: boolean | AutocaptureOptions;
  flushAt?: number;
  flushInterval?: number;
  retryCount?: number;
  maxQueueSize?: number;
  logger?: {
    enabled?: boolean;
    levels?: LogLevel[];
  };
  ready?: (formo: IFormoAnalytics) => void;
}

export interface FormoAnalyticsProviderProps {
  writeKey: string;
  options?: Options;
  disabled?: boolean;
  children: ReactNode;
}
