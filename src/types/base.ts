import { LogLevel } from "../logger";
import {
  IFormoEventContext,
  IFormoEventProperties,
  SignatureStatus,
  TransactionStatus,
} from "./events";
import { EIP1193Provider } from "./provider";
import { PrivyUser } from "../privy/types";
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
  cleanup(): void;
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
  identifyPrivyUser(
    user: PrivyUser,
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
 * Configuration options for referral parameter parsing
 */
export interface ReferralOptions {
  /**
   * Custom query parameter names to check for referral codes
   * @default ["ref", "referral", "refcode"]
   * @example ["via", "referrer", "source"] - will check ?via=CODE, ?referrer=CODE, ?source=CODE
   */
  queryParams?: string[];

  /**
   * URL path pattern to extract referral code from
   * Should be a regex string that matches the path segment containing the referral code
   * The first capture group will be used as the referral code
   * @example "/r/([^/]+)" - will extract "01K17FKB" from "https://glider.fi/r/01K17FKB"
   */
  pathPattern?: string;
}

/**
 * Configuration options for Wagmi integration
 * Allows the SDK to hook into Wagmi v2 wallet events instead of wrapping EIP-1193 providers
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

export interface Options {
  provider?: EIP1193Provider;
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
   * When provided, the SDK will hook into Wagmi's event system instead of wrapping EIP-1193 providers
   * This replaces the default provider tracking with Wagmi's config.subscribe() and MutationCache
   * @requires wagmi@>=2.0.0
   * @requires @tanstack/react-query@>=5.0.0 (for mutation tracking)
   */
  wagmi?: WagmiOptions;
  /**
   * Custom API host for sending events through your own domain to bypass ad blockers
   * - If not provided, events are sent directly to events.formo.so
   * - When provided, events are sent to your custom endpoint which should forward them to Formo
   * - Example: 'https://your-host-url.com/ingest' or '/api/analytics'
   * 
   * See https://docs.formo.so/sdks/web#proxy for setup instructions
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
   * Configuration for referral parameter parsing from URLs
   * Allows customizing how referral codes are detected from query parameters and URL paths
   * @example { queryParams: ["via"], pathPattern: "/r/([^/]+)" }
   */
  referral?: ReferralOptions;
  /**
   * Optional error handler for analytics network failures.
   * Called when event flush fails after all retries.
   * If not provided, errors are silently swallowed.
   */
  errorHandler?: (err: Error) => void;
  ready?: (formo: IFormoAnalytics) => void;
}

export interface FormoAnalyticsProviderProps {
  writeKey: string;
  options?: Options;
  disabled?: boolean;
  children: ReactNode;
}
