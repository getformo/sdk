import { ReactNode } from "react";
import { LogLevel } from "../lib/logger";
import {
  IFormoEventContext,
  IFormoEventProperties,
  SignatureStatus,
  TransactionStatus,
} from "./events";

export type Nullable<T> = T | null;
// Decimal chain ID
export type ChainID = number;

// Address (EVM, Solana, etc.)
export type Address = string;

export type ValidInputTypes = Uint8Array | bigint | string | number | boolean;

export interface IFormoAnalytics {
  screen(
    name: string,
    properties?: IFormoEventProperties,
    context?: IFormoEventContext,
    callback?: (...args: unknown[]) => void
  ): Promise<void>;
  reset(): void;
  cleanup(): void | Promise<void>;
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
    params?: { chainId?: ChainID; address?: Address },
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
      function_name?: string;
      function_args?: Record<string, unknown>;
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
  excludeChains?: ChainID[];
}

/**
 * Configuration options for controlling wallet event autocapture
 * All events are enabled by default unless explicitly set to false
 */
export interface AutocaptureOptions {
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
}

/**
 * Configuration options for Wagmi integration
 * Allows the SDK to hook into Wagmi v2 wallet events
 */
export interface WagmiOptions {
  /**
   * Wagmi config instance from createConfig()
   * The SDK will subscribe to this config's state changes to track wallet events
   */
  config: any;

  /**
   * Optional QueryClient instance from @tanstack/react-query
   * Required for tracking signature and transaction events via mutation cache
   * If not provided, only connection/disconnection/chain events will be tracked
   */
  queryClient?: any;
}

/**
 * App information for context enrichment
 */
export interface AppInfo {
  /**
   * App name
   */
  name?: string;

  /**
   * App version
   */
  version?: string;

  /**
   * App build number
   */
  build?: string;

  /**
   * Bundle/package identifier
   */
  bundleId?: string;
}

export interface Options {
  tracking?: boolean | TrackingOptions;
  /**
   * Control wallet event autocapture
   * - `false`: Disable all wallet autocapture
   * - `true`: Enable all wallet events (default)
   * - `AutocaptureOptions`: Granular control over specific events
   * @default true
   */
  autocapture?: boolean | AutocaptureOptions;
  /**
   * Wagmi integration configuration
   * When provided, the SDK will hook into Wagmi's event system
   * @requires wagmi@>=2.0.0
   * @requires @tanstack/react-query@>=5.0.0 (for mutation tracking)
   */
  wagmi?: WagmiOptions;
  /**
   * Custom API host for sending events
   */
  apiHost?: string;
  flushAt?: number;
  flushInterval?: number;
  retryCount?: number;
  maxQueueSize?: number;
  logger?: {
    enabled?: boolean;
    levels?: LogLevel[];
  };
  /**
   * App information for context enrichment
   */
  app?: AppInfo;
  ready?: (formo: IFormoAnalytics) => void;
}

export interface FormoAnalyticsProviderProps {
  writeKey: string;
  options?: Options;
  disabled?: boolean;
  children: ReactNode;
}
