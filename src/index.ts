import { formofy } from "./initialization";
export * from "./FormoAnalyticsProvider";
export * from "./FormoAnalytics";
export * from "./types";

// Solana integration exports
export { SolanaWalletAdapterHandler } from "./solana";
export type {
  SolanaOptions,
  SolanaCluster,
  SolanaWalletAdapter,
  SolanaWalletContext,
  SolanaPublicKey,
  SolanaConnection,
  SolanaTrackingState,
} from "./solana";
export {
  SOLANA_CHAIN_IDS,
  SOLANA_CLUSTERS_BY_ID,
  DEFAULT_SOLANA_CHAIN_ID,
  // Type guards
  isSolanaWalletContext,
  isSolanaWalletAdapter,
  // Address utilities
  isSolanaAddress,
  getValidSolanaAddress,
  isBlockedSolanaAddress,
  publicKeyToAddress,
  areSolanaAddressesEqual,
} from "./solana";

if (typeof window !== "undefined") window.formofy = formofy;
