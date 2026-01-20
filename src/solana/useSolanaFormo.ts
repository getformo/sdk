/**
 * React Hook for Solana Wallet Integration with Formo Analytics
 *
 * This hook provides a convenient way to integrate Solana wallet tracking
 * with the Formo analytics SDK in React applications.
 *
 * @example
 * ```tsx
 * import { useSolanaFormo } from '@formo/analytics';
 * import { useWallet, useConnection } from '@solana/wallet-adapter-react';
 *
 * function MyComponent() {
 *   const wallet = useWallet();
 *   const { connection } = useConnection();
 *
 *   // Hook automatically tracks wallet events
 *   const { trackSignature, trackTransaction, isConnected } = useSolanaFormo({
 *     wallet,
 *     cluster: 'mainnet-beta'
 *   });
 *
 *   const handleSign = async () => {
 *     // Signatures are auto-tracked when using wallet.signMessage
 *     // But you can also manually track:
 *     await trackSignature({
 *       status: 'confirmed',
 *       message: 'Hello',
 *       signatureHash: '...'
 *     });
 *   };
 *
 *   return <div>Connected: {isConnected ? 'Yes' : 'No'}</div>;
 * }
 * ```
 */

import { useEffect, useRef, useCallback, useMemo } from "react";
import { useFormo } from "../FormoAnalyticsProvider";
import { SolanaEventHandler } from "./SolanaEventHandler";
import { SolanaCluster, SolanaWalletAdapter } from "./types";
import { SignatureStatus, TransactionStatus } from "../types/events";
import { logger } from "../logger";

export interface UseSolanaFormoOptions {
  /**
   * The wallet adapter instance from useWallet() hook
   */
  wallet: SolanaWalletAdapter;

  /**
   * The current Solana cluster/network
   * @default "mainnet-beta"
   */
  cluster?: SolanaCluster;

  /**
   * Polling interval in milliseconds for detecting wallet state changes
   * @default 500
   */
  pollIntervalMs?: number;

  /**
   * Whether to enable tracking (useful for conditional tracking)
   * @default true
   */
  enabled?: boolean;
}

export interface UseSolanaFormoReturn {
  /**
   * Whether the wallet is currently connected
   */
  isConnected: boolean;

  /**
   * The current connected wallet address (base58 format)
   */
  address: string | undefined;

  /**
   * The current cluster
   */
  cluster: SolanaCluster;

  /**
   * Manually track a signature event
   */
  trackSignature: (params: {
    status: SignatureStatus;
    message: string;
    signatureHash?: string;
  }) => Promise<void>;

  /**
   * Manually track a transaction event
   */
  trackTransaction: (params: {
    status: TransactionStatus;
    transactionHash?: string;
    to?: string;
    value?: string;
  }) => Promise<void>;

  /**
   * Update the cluster (triggers chain change event if connected)
   */
  updateCluster: (cluster: SolanaCluster) => void;
}

/**
 * React hook for integrating Solana wallet tracking with Formo Analytics.
 *
 * This hook creates and manages a SolanaEventHandler that automatically
 * tracks wallet connection, disconnection, signature, and transaction events.
 *
 * @param options Configuration options for Solana tracking
 * @returns Object with tracking methods and wallet state
 */
export function useSolanaFormo(
  options: UseSolanaFormoOptions
): UseSolanaFormoReturn {
  const { wallet, cluster = "mainnet-beta", pollIntervalMs, enabled = true } = options;

  const formo = useFormo();
  const handlerRef = useRef<SolanaEventHandler | null>(null);

  // Create handler when formo is ready and enabled
  useEffect(() => {
    if (!formo || !enabled) {
      return;
    }

    // Clean up existing handler
    if (handlerRef.current) {
      handlerRef.current.cleanup();
      handlerRef.current = null;
    }

    // Create new handler
    // Note: We create the handler directly here since formo might not have
    // Solana options configured (user is using the hook instead)
    try {
      handlerRef.current = new SolanaEventHandler(
        formo as any, // FormoAnalytics instance
        wallet,
        cluster,
        pollIntervalMs
      );
    } catch (error) {
      logger.error("useSolanaFormo: Failed to create handler:", error);
    }

    return () => {
      if (handlerRef.current) {
        handlerRef.current.cleanup();
        handlerRef.current = null;
      }
    };
  }, [formo, wallet, cluster, pollIntervalMs, enabled]);

  // Update cluster when it changes
  useEffect(() => {
    if (handlerRef.current && cluster) {
      handlerRef.current.updateCluster(cluster);
    }
  }, [cluster]);

  const trackSignature = useCallback(
    async (params: {
      status: SignatureStatus;
      message: string;
      signatureHash?: string;
    }) => {
      if (handlerRef.current) {
        await handlerRef.current.trackSignature(params);
      }
    },
    []
  );

  const trackTransaction = useCallback(
    async (params: {
      status: TransactionStatus;
      transactionHash?: string;
      to?: string;
      value?: string;
    }) => {
      if (handlerRef.current) {
        await handlerRef.current.trackTransaction(params);
      }
    },
    []
  );

  const updateCluster = useCallback((newCluster: SolanaCluster) => {
    if (handlerRef.current) {
      handlerRef.current.updateCluster(newCluster);
    }
  }, []);

  const result = useMemo(
    () => ({
      isConnected: wallet.connected,
      address: wallet.publicKey?.toBase58(),
      cluster,
      trackSignature,
      trackTransaction,
      updateCluster,
    }),
    [
      wallet.connected,
      wallet.publicKey,
      cluster,
      trackSignature,
      trackTransaction,
      updateCluster,
    ]
  );

  return result;
}

export default useSolanaFormo;
