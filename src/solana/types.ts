/**
 * Solana-specific type definitions for wallet event tracking
 *
 * Core types for the Solana integration: cluster mappings, chain ID utilities,
 * and configuration options. Framework-kit store types are in storeTypes.ts.
 *
 * @see https://github.com/solana-foundation/framework-kit
 */

import type { AutocaptureEventType } from "../tracking/TrackingPolicy";
import type { TransactionStatus } from "../types/events";
import type { WalletRestore } from "../wallet/WalletStateStore";

/** A wallet in a Solana namespace: who, and on which cluster. */
export interface SolanaConnection {
  address: string;
  chainId: number;
}

/**
 * What a Solana capture path needs from the SDK that owns it.
 *
 * Both paths take this rather than the SDK class: it names the surface they
 * use, it lets a test build one without the class, and it keeps the SDK from
 * depending on this module and back again.
 */
export interface SolanaCaptureDeps {
  isAutocaptureEnabled(eventType: AutocaptureEventType): boolean;
  connect(
    params: SolanaConnection,
    properties: { providerName: string; rdns: string }
  ): Promise<void>;
  disconnect(params: SolanaConnection): Promise<void>;
  chain(params: SolanaConnection): Promise<void>;
  /**
   * Put a still-connected wallet back after a disconnect cleared the Solana
   * namespace, without taking the active slot from another namespace.
   * @see FormoAnalytics.restoreWalletState
   */
  restoreWalletState(params: SolanaConnection): void;
  /**
   * A restore decided before `disconnect()` is awaited and written after.
   * Refused if the namespace changed hands or was reset meanwhile.
   * @see FormoAnalytics.deferWalletRestore
   */
  deferWalletRestore(chainId: number): WalletRestore;
  /** The wallet held in the Solana namespace, active or not. */
  solanaAddress(): string | undefined;
}

/** What the framework-kit store handler adds to the shared surface. */
export interface SolanaStoreHandlerDeps extends SolanaCaptureDeps {
  transaction(params: {
    status: TransactionStatus;
    chainId: number;
    address: string;
    transactionHash?: string;
  }): Promise<void>;
}

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
 * The rdns reported for a Solana wallet.
 *
 * The Wallet Standard has no reverse-domain identifier, so one is derived
 * from the wallet's normalized name. Lowercasing and removing whitespace
 * preserves the values historically reported by the framework-kit store;
 * encoding keeps delimiters and other special characters safe for storage.
 * Both Solana paths (Wallet Standard discovery and the framework-kit store)
 * derive it the same way, so a wallet's `detect` and its `connect` share one
 * rdns whichever path reported each.
 */
export function solanaWalletRdns(walletName: string): string {
  return `sol.wallet.${encodeURIComponent(walletName.toLowerCase().replace(/\s+/g, ""))}`;
}

/**
 * Solana options for FormoAnalytics.
 *
 * Wallet discovery through the Wallet Standard is on by default and needs
 * none of these. They add framework-kit's store, or name the cluster.
 */
export interface SolanaOptions {
  /**
   * The framework-kit client store (client.store).
   * When provided, transaction lifecycle events and cluster switches are
   * tracked from the store, and connect/disconnect come from the store
   * rather than from Wallet Standard discovery.
   *
   * Only for apps using framework-kit (`@solana/client`). Other integrations
   * do not need a store when their wallets register through Wallet Standard.
   *
   * @example
   * ```tsx
   * import { createClient, autoDiscover } from '@solana/client';
   * const client = createClient({ endpoint, walletConnectors: autoDiscover() });
   * const formo = await Formo.init(writeKey, { solana: { store: client.store } });
   * ```
   */
  store?: import("./storeTypes").SolanaClientStore;

  /**
   * The Solana cluster/network the app is on.
   *
   * With a store, usually auto-detected from its endpoint URL; only needed
   * for custom RPC URLs that don't contain a recognizable cluster name.
   * Without a store, the Wallet Standard cannot say which cluster the app
   * uses, so a devnet or testnet app should set this (or call
   * `formo.solana.setCluster()`); otherwise connections are reported on
   * mainnet-beta.
   * @default auto-detected from the store; otherwise mainnet-beta when the
   * wallet supports it, or its first supported Solana cluster
   */
  cluster?: SolanaCluster;
}
