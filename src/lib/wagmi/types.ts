/**
 * Wagmi-specific type definitions for wallet event tracking
 * 
 * These types provide TypeScript interfaces for Wagmi v2 integration,
 * allowing the SDK to hook into Wagmi's config.subscribe() and MutationCache
 * to track wallet events without wrapping EIP-1193 providers.
 */

/**
 * Wagmi config state structure
 * Based on Wagmi v2 internal state
 */
export interface WagmiState {
  chainId?: number;
  connections: Map<string, WagmiConnection>;
  current?: string;
  status: 'connected' | 'disconnected' | 'connecting' | 'reconnecting';
}

/**
 * Wagmi connection information
 */
export interface WagmiConnection {
  accounts: readonly string[];
  chainId: number;
  connector: WagmiConnector;
}

/**
 * Wagmi connector interface
 */
export interface WagmiConnector {
  id: string;
  name: string;
  type: string;
  uid: string;
}

/**
 * Wagmi config interface
 * This is the config object returned by createConfig()
 */
export interface WagmiConfig {
  subscribe<TData>(
    selector: (state: WagmiState) => TData,
    listener: (selectedState: TData, previousSelectedState: TData) => void,
    options?: {
      equalityFn?: (a: TData, b: TData) => boolean;
      fireImmediately?: boolean;
    }
  ): () => void;
  
  getState(): WagmiState;
}

/**
 * React Query (TanStack Query) mutation state
 */
export interface MutationState {
  status: 'idle' | 'pending' | 'success' | 'error';
  data?: any;
  error?: Error | null;
  variables?: any;
  context?: any;
}

/**
 * React Query mutation object
 */
export interface Mutation {
  state: MutationState;
  options: {
    mutationKey?: readonly unknown[];
    [key: string]: any;
  };
}

/**
 * React Query mutation cache event
 */
export interface MutationCacheEvent {
  type: 'added' | 'removed' | 'updated';
  mutation: Mutation;
}

/**
 * React Query MutationCache interface
 */
export interface MutationCache {
  subscribe(
    listener: (event: MutationCacheEvent) => void
  ): () => void;
}

/**
 * React Query QueryClient interface
 */
export interface QueryClient {
  getMutationCache(): MutationCache;
}

/**
 * Unsubscribe function returned by subscriptions
 */
export type UnsubscribeFn = () => void;

/**
 * Wagmi mutation key types for identifying wallet operations
 */
export type WagmiMutationKey = 
  | 'signMessage'
  | 'signTypedData' 
  | 'sendTransaction'
  | 'writeContract';

/**
 * Internal tracking state for Wagmi event handler
 */
export interface WagmiTrackingState {
  lastChainId?: number;
  lastAddress?: string;
  lastStatus?: WagmiState['status'];
  isProcessing: boolean;
}

