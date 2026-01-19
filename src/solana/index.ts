/**
 * Solana Wallet Integration Module
 *
 * Provides integration with Solana wallet adapter for tracking wallet events.
 *
 * @example
 * ```typescript
 * import { SolanaEventHandler, SolanaOptions } from '@formo/analytics';
 * import { useWallet } from '@solana/wallet-adapter-react';
 *
 * // In your component
 * const wallet = useWallet();
 *
 * // Configure Formo with Solana wallet
 * <FormoAnalyticsProvider
 *   writeKey="wk_xxx"
 *   options={{
 *     solana: {
 *       wallet,
 *       cluster: 'mainnet-beta'
 *     }
 *   }}
 * >
 *   <App />
 * </FormoAnalyticsProvider>
 * ```
 */

export { SolanaEventHandler } from "./SolanaEventHandler";
export type {
  SolanaOptions,
  SolanaCluster,
  SolanaWalletAdapter,
  SolanaTrackingState,
  SolanaSignatureParams,
  SolanaTransactionParams,
} from "./types";
export { SOLANA_CHAIN_IDS, KNOWN_SOLANA_WALLETS } from "./types";
