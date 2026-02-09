/**
 * Solana-specific type definitions for wallet event tracking
 *
 * These types provide TypeScript interfaces for Solana Wallet Adapter integration,
 * allowing the SDK to hook into Solana wallet events to track wallet interactions.
 *
 * @see https://github.com/anza-xyz/wallet-adapter
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
 * Solana PublicKey interface
 * Represents a Solana public key (32 bytes, Base58 encoded)
 */
export interface SolanaPublicKey {
  toBase58(): string;
  toString(): string;
  toBytes(): Uint8Array;
  equals(other: SolanaPublicKey): boolean;
}

/**
 * Solana transaction signature (64 bytes, Base58 encoded)
 */
export type TransactionSignature = string;

/**
 * Solana wallet adapter state
 */
export type WalletAdapterState =
  | "connected"
  | "disconnected"
  | "connecting"
  | "disconnecting";

/**
 * Solana wallet adapter interface
 * Based on @solana/wallet-adapter-base WalletAdapter
 */
export interface SolanaWalletAdapter {
  name: string;
  url: string;
  icon: string;
  readyState: WalletReadyState;
  publicKey: SolanaPublicKey | null;
  connecting: boolean;
  connected: boolean;

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendTransaction?(
    transaction: SolanaTransaction,
    connection: SolanaConnection,
    options?: SendTransactionOptions
  ): Promise<TransactionSignature>;
  signTransaction?(
    transaction: SolanaTransaction
  ): Promise<SolanaTransaction>;
  signAllTransactions?(
    transactions: SolanaTransaction[]
  ): Promise<SolanaTransaction[]>;
  signMessage?(message: Uint8Array): Promise<Uint8Array>;

  on(event: "connect", listener: (publicKey: SolanaPublicKey) => void): void;
  on(event: "disconnect", listener: () => void): void;
  on(event: "error", listener: (error: WalletError) => void): void;
  on(event: "readyStateChange", listener: (readyState: WalletReadyState) => void): void;
  off(event: string, listener: (...args: unknown[]) => void): void;
  removeAllListeners?(event?: string): void;
}

/**
 * Solana wallet entry from @solana/wallet-adapter-react
 */
export interface SolanaWallet {
  adapter: SolanaWalletAdapter;
  readyState: WalletReadyState;
}

/**
 * Solana wallet ready state
 */
export enum WalletReadyState {
  Installed = "Installed",
  NotDetected = "NotDetected",
  Loadable = "Loadable",
  Unsupported = "Unsupported",
}

/**
 * Solana wallet error
 */
export interface WalletError extends Error {
  error?: unknown;
}

/**
 * Solana transaction interface (minimal)
 */
export interface SolanaTransaction {
  signature?: Uint8Array;
  serialize(): Uint8Array;
  feePayer?: SolanaPublicKey;
  recentBlockhash?: string;
}

/**
 * Solana connection interface (minimal)
 */
export interface SolanaConnection {
  rpcEndpoint: string;
  commitment?: string;
  getSignatureStatus?(
    signature: string
  ): Promise<{ value: SignatureStatus | null }>;
  getSignatureStatuses?(
    signatures: string[]
  ): Promise<{ value: (SignatureStatus | null)[] }>;
}

/**
 * Solana signature status
 */
export interface SignatureStatus {
  slot: number;
  confirmations: number | null;
  err: unknown | null;
  confirmationStatus?: "processed" | "confirmed" | "finalized";
}

/**
 * Send transaction options
 */
export interface SendTransactionOptions {
  skipPreflight?: boolean;
  preflightCommitment?: string;
  maxRetries?: number;
  minContextSlot?: number;
}

/**
 * Solana Wallet Context interface
 * Based on @solana/wallet-adapter-react useWallet hook
 * @see https://github.com/anza-xyz/wallet-adapter/blob/master/packages/core/react/src/useWallet.ts
 */
export interface SolanaWalletContext {
  autoConnect: boolean;
  wallets: SolanaWallet[];
  wallet: SolanaWallet | null;
  publicKey: SolanaPublicKey | null;
  connecting: boolean;
  connected: boolean;
  disconnecting: boolean;

  select(walletName: string | null): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendTransaction(
    transaction: SolanaTransaction,
    connection: SolanaConnection,
    options?: SendTransactionOptions
  ): Promise<TransactionSignature>;
  signTransaction?(
    transaction: SolanaTransaction
  ): Promise<SolanaTransaction>;
  signAllTransactions?(
    transactions: SolanaTransaction[]
  ): Promise<SolanaTransaction[]>;
  signMessage?(message: Uint8Array): Promise<Uint8Array>;
}

/**
 * Solana options for FormoAnalytics
 */
export interface SolanaOptions {
  /**
   * The Solana wallet adapter instance or wallet context
   * Can be a single wallet adapter or the useWallet() context
   */
  wallet?: SolanaWalletAdapter | SolanaWalletContext;

  /**
   * The Solana connection for tracking transaction confirmations
   */
  connection?: SolanaConnection;

  /**
   * The Solana cluster/network
   * @default "mainnet-beta"
   */
  cluster?: SolanaCluster;

  /**
   * Custom chain ID to use instead of the default Solana chain IDs
   * Useful if you have a custom indexing pipeline that expects specific IDs
   */
  chainId?: number;
}

/**
 * Internal tracking state for Solana event handler
 */
export interface SolanaTrackingState {
  lastAddress?: string;
  lastCluster?: SolanaCluster;
  lastChainId?: number;
  isProcessing: boolean;
}

/**
 * Unsubscribe function type
 */
export type UnsubscribeFn = () => void;

/**
 * Check if an object is a SolanaWalletContext (has wallets array)
 */
export function isSolanaWalletContext(
  obj: SolanaWalletAdapter | SolanaWalletContext | undefined | null
): obj is SolanaWalletContext {
  return (
    obj !== null &&
    obj !== undefined &&
    typeof obj === "object" &&
    "wallets" in obj &&
    Array.isArray((obj as SolanaWalletContext).wallets)
  );
}

/**
 * Check if an object is a SolanaWalletAdapter
 */
export function isSolanaWalletAdapter(
  obj: SolanaWalletAdapter | SolanaWalletContext | undefined | null
): obj is SolanaWalletAdapter {
  return (
    obj !== null &&
    obj !== undefined &&
    typeof obj === "object" &&
    "name" in obj &&
    "connect" in obj &&
    !("wallets" in obj)
  );
}
