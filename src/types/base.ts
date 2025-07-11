import { LogLevel } from "../lib";
import {
  IFormoEventContext,
  IFormoEventProperties,
  SignatureStatus,
  TransactionStatus,
} from "./events";
import { EIP1193Provider } from "./provider";

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
  ): void;
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
}

export interface Options {
  provider?: EIP1193Provider;
  trackLocalhost?: boolean;

  flushAt?: number;
  flushInterval?: number;
  retryCount?: number;
  maxQueueSize?: number;
  logger?: {
    enabled: boolean;
    levels?: LogLevel[];
  };
}

export interface FormoAnalyticsProviderProps {
  writeKey: string;
  options?: Options;
  disabled?: boolean;
  children: React.ReactNode;
}

export interface Config {
  writeKey: string;
  trackLocalhost?: boolean;
}
