import { EIP1193Provider } from "./wallet";

export type ChainID = string | number

export interface Options {
  provider?: EIP1193Provider;
}

export interface FormoAnalyticsProviderProps {
  apiKey: string;
  options?: Options;
  disabled?: boolean;
  children: React.ReactNode;
}
