/**
 * Type definitions for framework-kit's zustand store integration.
 *
 * These types mirror the state shape of @solana-foundation/framework-kit's
 * vanilla zustand store, allowing the SDK to subscribe to wallet and
 * transaction state changes without wrapping any wallet methods.
 *
 * @see https://github.com/solana-foundation/framework-kit
 */

/**
 * The complete framework-kit client state shape.
 * We only type the fields we subscribe to.
 */
export interface SolanaClientState {
  transactions: SolanaTransactionState;
  wallet: SolanaWalletStatus;
  cluster: SolanaClusterState;
  lastUpdatedAt: number;
}

/**
 * Transaction records keyed by signature.
 */
export type SolanaTransactionState = Record<string, SolanaTransactionRecord>;

/**
 * Individual transaction record in the store.
 */
export interface SolanaTransactionRecord {
  readonly error?: unknown;
  readonly lastUpdatedAt: number;
  readonly signature?: string;
  readonly status: "idle" | "sending" | "waiting" | "confirmed" | "failed";
}

/**
 * Wallet status — discriminated union.
 */
export type SolanaWalletStatus =
  | SolanaWalletDisconnected
  | SolanaWalletConnecting
  | SolanaWalletConnected
  | SolanaWalletError;

export interface SolanaWalletDisconnected {
  readonly status: "disconnected";
}

export interface SolanaWalletConnecting {
  readonly status: "connecting";
  readonly connectorId: string;
  readonly autoConnect?: boolean;
}

export interface SolanaWalletConnected {
  readonly status: "connected";
  readonly connectorId: string;
  readonly session: SolanaWalletSession;
  readonly autoConnect?: boolean;
}

export interface SolanaWalletError {
  readonly status: "error";
  readonly connectorId?: string;
  readonly error: unknown;
  readonly autoConnect?: boolean;
}

/**
 * Wallet session — carries the connected wallet's capabilities and account.
 */
export interface SolanaWalletSession {
  readonly account: SolanaWalletAccount;
  readonly connector: SolanaWalletConnectorMetadata;
  disconnect(): Promise<void>;
}

export interface SolanaWalletAccount {
  readonly address: string;
  readonly label?: string;
  readonly publicKey?: unknown;
}

export interface SolanaWalletConnectorMetadata {
  readonly id: string;
  readonly name: string;
  readonly icon?: string;
}

/**
 * Cluster state from the store.
 */
export interface SolanaClusterState {
  readonly endpoint: string;
  readonly commitment?: string;
  readonly status: "idle" | "connecting" | "ready" | "error";
}

/**
 * The zustand vanilla store API that framework-kit exposes via `client.store`.
 * Supports both selector-based and full-state subscriptions.
 */
export interface SolanaClientStore {
  getState(): SolanaClientState;

  /**
   * Subscribe to all state changes.
   */
  subscribe(listener: (state: SolanaClientState, prevState: SolanaClientState) => void): () => void;

  /**
   * Subscribe to a selected slice of state (zustand vanilla API).
   */
  subscribe<T>(
    selector: (state: SolanaClientState) => T,
    listener: (selectedState: T, previousSelectedState: T) => void,
    options?: { equalityFn?: (a: T, b: T) => boolean; fireImmediately?: boolean }
  ): () => void;
}

/**
 * Options for configuring the store-based Solana integration.
 */
export interface SolanaStoreOptions {
  /**
   * The framework-kit client store (client.store).
   * This is a vanilla zustand store that tracks wallet, transaction, and cluster state.
   */
  store: SolanaClientStore;
}
