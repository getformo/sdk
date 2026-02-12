import { formofy } from "./initialization";
export * from "./FormoAnalyticsProvider";
export * from "./FormoAnalytics";
export * from "./types";

// Solana integration exports
export { SolanaManager } from "./solana";
export type {
  SolanaOptions,
  SolanaCluster,
  ISolanaAdapter,
  SolanaWalletContext,
  SolanaPublicKey,
  SolanaConnection,
} from "./solana";

if (typeof window !== "undefined") window.formofy = formofy;
