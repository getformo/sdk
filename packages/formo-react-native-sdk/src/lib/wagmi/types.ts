/**
 * Wagmi types for React Native SDK
 */

export interface WagmiState {
  status: "connecting" | "connected" | "disconnected" | "reconnecting";
  connections: Map<
    string,
    {
      accounts: readonly string[];
      chainId: number;
      connector: {
        name: string;
        id: string;
      };
    }
  >;
  current?: string;
  chainId?: number;
}

export interface WagmiConfig {
  subscribe: <T>(
    selector: (state: WagmiState) => T,
    listener: (selectedState: T, prevSelectedState: T) => void
  ) => () => void;
  getState?: () => WagmiState;
  state?: WagmiState;
}

export interface QueryClient {
  getMutationCache: () => MutationCache;
}

export interface MutationCache {
  subscribe: (callback: (event: MutationCacheEvent) => void) => () => void;
}

export interface MutationCacheEvent {
  type: "added" | "updated" | "removed";
  mutation: {
    mutationId: number;
    options: {
      mutationKey?: readonly string[];
    };
    state: {
      status: "idle" | "pending" | "success" | "error";
      data?: unknown;
      error?: unknown;
      variables?: Record<string, unknown>;
    };
  };
}

export type UnsubscribeFn = () => void;

export interface WagmiTrackingState {
  isProcessing: boolean;
  lastAddress?: string;
  lastChainId?: number;
  lastStatus?: WagmiState["status"];
}

export type WagmiMutationKey =
  | "signMessage"
  | "signTypedData"
  | "sendTransaction"
  | "writeContract";
