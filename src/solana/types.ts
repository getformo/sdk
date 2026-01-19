/**
 * Solana Wallet Adapter Types
 *
 * Types and interfaces for integrating with @solana/wallet-adapter-react
 */

import { SignatureStatus, TransactionStatus } from "../types/events";

/**
 * Solana cluster/network types
 * These map to the standard Solana network endpoints
 */
export type SolanaCluster = "mainnet-beta" | "devnet" | "testnet" | "localnet";

/**
 * Pseudo chain IDs for Solana networks
 * These allow Solana networks to be represented in the existing chainId paradigm
 */
export const SOLANA_CHAIN_IDS: Record<SolanaCluster, number> = {
  "mainnet-beta": 101,
  devnet: 102,
  testnet: 103,
  localnet: 104,
} as const;

/**
 * Known Solana wallet providers with their identifying metadata
 */
export const KNOWN_SOLANA_WALLETS = [
  { name: "Phantom", rdns: "app.phantom.solana" },
  { name: "Solflare", rdns: "com.solflare" },
  { name: "Backpack", rdns: "app.backpack" },
  { name: "Glow", rdns: "app.glow" },
  { name: "Coinbase Wallet", rdns: "com.coinbase.wallet.solana" },
  { name: "Trust Wallet", rdns: "com.trustwallet.solana" },
  { name: "Ledger", rdns: "com.ledger.solana" },
  { name: "Torus", rdns: "app.torus.solana" },
  { name: "MathWallet", rdns: "com.mathwallet.solana" },
  { name: "Slope", rdns: "com.slope.solana" },
  { name: "BitKeep", rdns: "com.bitkeep.solana" },
  { name: "Exodus", rdns: "com.exodus.solana" },
] as const;

/**
 * Minimal interface for Solana wallet adapter
 * Compatible with @solana/wallet-adapter-react useWallet() hook
 */
export interface SolanaWalletAdapter {
  /** The public key of the connected wallet (null if disconnected) */
  publicKey: { toBase58(): string } | null;
  /** Whether the wallet is currently connected */
  connected: boolean;
  /** Whether the wallet is currently connecting */
  connecting: boolean;
  /** Whether the wallet is currently disconnecting */
  disconnecting: boolean;
  /** The name of the wallet adapter */
  wallet: {
    adapter: {
      name: string;
      icon?: string;
    };
  } | null;
  /** Sign a message with the wallet */
  signMessage?: (message: Uint8Array) => Promise<Uint8Array>;
  /** Sign a transaction */
  signTransaction?: <T>(transaction: T) => Promise<T>;
  /** Sign and send a transaction */
  sendTransaction?: <T>(
    transaction: T,
    connection: unknown,
    options?: unknown
  ) => Promise<string>;
}

/**
 * Configuration options for Solana wallet integration
 */
export interface SolanaOptions {
  /**
   * The wallet adapter instance from useWallet() hook
   * This is required for tracking wallet events
   */
  wallet: SolanaWalletAdapter;

  /**
   * The current Solana cluster/network
   * Used to determine the pseudo chain ID for events
   * @default "mainnet-beta"
   */
  cluster?: SolanaCluster;

  /**
   * Optional callback when Solana handler is ready
   */
  onReady?: () => void;
}

/**
 * Internal state for tracking Solana wallet events
 */
export interface SolanaTrackingState {
  /** Prevents concurrent processing of state changes */
  isProcessing: boolean;
  /** Last known connected address */
  lastAddress?: string;
  /** Last known cluster */
  lastCluster?: SolanaCluster;
  /** Last known connection status */
  lastConnected?: boolean;
}

/**
 * Solana signature event parameters
 */
export interface SolanaSignatureParams {
  status: SignatureStatus;
  address: string;
  message: string;
  signatureHash?: string;
  cluster?: SolanaCluster;
}

/**
 * Solana transaction event parameters
 */
export interface SolanaTransactionParams {
  status: TransactionStatus;
  address: string;
  transactionHash?: string;
  cluster?: SolanaCluster;
  /** Amount in lamports */
  amount?: string;
  /** Destination address */
  to?: string;
  /** Program ID being called */
  programId?: string;
}

/**
 * Type for unsubscribe functions
 */
export type UnsubscribeFn = () => void;
