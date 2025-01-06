import { EIP1193Provider } from "./wallet";

// Decimal chain ID
export type ChainID = number

// Address (EVM, Solana, etc.)
export type Address = string

export interface Options {
  provider?: EIP1193Provider;
}

export interface FormoAnalyticsProviderProps {
  apiKey: string;
  options?: Options;
  disabled?: boolean;
  children: React.ReactNode;
}

export interface Config {
  apiKey: string;
}