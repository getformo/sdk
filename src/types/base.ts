import { LogLevel } from "../lib";
import { EIP1193Provider } from "./provider";

// Decimal chain ID
export type ChainID = number;

// Address (EVM, Solana, etc.)
export type Address = string;

export type ValidInputTypes = Uint8Array | bigint | string | number | boolean;

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
