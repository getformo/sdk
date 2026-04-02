/**
 * Solana-specific type definitions for wallet event tracking
 *
 * Core types for the Solana integration: cluster mappings, chain ID utilities,
 * and configuration options. Framework-kit store types are in storeTypes.ts.
 *
 * @see https://github.com/solana-foundation/framework-kit
 */

/**
 * Solana cluster/network types
 * Solana doesn't use chainId like EVM, instead it uses cluster names
 */
export type SolanaCluster = "mainnet-beta" | "testnet" | "devnet" | "localnet";

/**
 * Mapping of Solana clusters to numeric chain IDs for consistency with EVM events
 * These IDs are non-standard but provide a way to identify Solana networks in our analytics
 *
 * Using high numbers (900000+) to avoid collision with EVM chain IDs
 * @see https://chainlist.org for EVM chain IDs (typically < 100000)
 */
export const SOLANA_CHAIN_IDS: Record<SolanaCluster, number> = {
  "mainnet-beta": 900001,
  testnet: 900002,
  devnet: 900003,
  localnet: 900004,
} as const;

/**
 * Reverse mapping from chain ID to cluster name
 */
export const SOLANA_CLUSTERS_BY_ID: Record<number, SolanaCluster> = {
  900001: "mainnet-beta",
  900002: "testnet",
  900003: "devnet",
  900004: "localnet",
} as const;

/**
 * Default Solana chain ID (mainnet-beta)
 */
export const DEFAULT_SOLANA_CHAIN_ID = SOLANA_CHAIN_IDS["mainnet-beta"];

/**
 * Check if a chain ID belongs to a Solana network.
 */
export function isSolanaChainId(chainId: number | undefined | null): boolean {
  if (chainId === undefined || chainId === null) return false;
  return Object.values(SOLANA_CHAIN_IDS).includes(chainId);
}

/**
 * Solana PublicKey interface
 * Used by address validation utilities.
 */
export interface SolanaPublicKey {
  toBase58(): string;
  toString(): string;
  toBytes(): Uint8Array;
  equals(other: SolanaPublicKey): boolean;
}

/**
 * Unsubscribe function type
 */
export type UnsubscribeFn = () => void;

/**
 * Solana options for FormoAnalytics
 */
export interface SolanaOptions {
  /**
   * The framework-kit client store (client.store) for automatic event tracking.
   * When provided, wallet connect/disconnect and transaction events are tracked
   * automatically by subscribing to zustand store state changes.
   *
   * This is the recommended approach for apps using @solana-foundation/framework-kit.
   *
   * @example
   * ```tsx
   * import { createClient } from '@solana-foundation/framework-kit';
   * const client = createClient({ endpoint, walletConnectors: autoDiscover() });
   * const formo = await Formo.init(writeKey, { solana: { store: client.store } });
   * ```
   */
  store?: import("./storeTypes").SolanaClientStore;

  /**
   * The Solana cluster/network.
   * Usually auto-detected from the store's endpoint URL.
   * Only needed for custom RPC URLs that don't contain a recognizable cluster name.
   * @default auto-detected, or "mainnet-beta" if detection fails
   */
  cluster?: SolanaCluster;
}
