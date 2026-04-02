import { formofy } from "./initialization";
export * from "./FormoAnalyticsProvider";
export * from "./FormoAnalytics";
export * from "./types";
export { parsePrivyProperties } from "./privy";
export type { PrivyUser, PrivyLinkedAccount, PrivyAccountType, PrivyProfileProperties, PrivyWalletInfo } from "./privy";

// Solana integration exports
export { SolanaManager } from "./solana";
export type {
  SolanaOptions,
  SolanaCluster,
} from "./solana";
export type {
  SolanaClientStore,
  SolanaClientState,
} from "./solana";

if (typeof window !== "undefined") window.formofy = formofy;
