/**
 * Wagmi integration module
 * 
 * Provides integration with Wagmi v2 for wallet event tracking.
 * This module exports the WagmiEventHandler and related types.
 */

export { WagmiEventHandler } from "./WagmiEventHandler";
export type {
  WagmiState,
  WagmiConnection,
  WagmiConnector,
  WagmiConfig,
  MutationState,
  Mutation,
  MutationCacheEvent,
  MutationCache,
  QueryClient,
  UnsubscribeFn,
  WagmiMutationKey,
  WagmiTrackingState,
} from "./types";

