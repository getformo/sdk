// React-free entry point.
// Use this from non-React frameworks (Angular, Vue, Svelte, vanilla JS) to
// avoid pulling the React provider into the dependency graph.
//
// Equivalent to the package root entry minus FormoAnalyticsProvider/useFormo
// and the `window.formofy = formofy` side effect.

export * from "./FormoAnalytics";
export * from "./types";
export { formofy } from "./initialization";

export { parsePrivyProperties } from "./privy";
export type {
  PrivyUser,
  PrivyLinkedAccount,
  PrivyAccountType,
  PrivyProfileProperties,
  PrivyWalletInfo,
} from "./privy";

export { SolanaManager } from "./solana";
export {
  SOLANA_CHAIN_IDS,
  DEFAULT_SOLANA_CHAIN_ID,
  isSolanaChainId,
} from "./solana";
export type { SolanaOptions, SolanaCluster } from "./solana";
export type { SolanaClientStore, SolanaClientState } from "./solana";
