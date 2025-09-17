/**
 * Drop-in replacement hooks for Wagmi with automatic Formo Analytics tracking
 * 
 * These hooks have the exact same API as the original Wagmi hooks but automatically
 * emit Formo Analytics events. Simply replace your Wagmi imports:
 * 
 * @example
 * ```tsx
 * // Before
 * import { useSignMessage, useSendTransaction } from 'wagmi';
 * 
 * // After  
 * import { useSignMessage, useSendTransaction } from '@formo/analytics/wagmi';
 * ```
 */

import { useCallback } from "react";
import { useFormo } from "../../FormoAnalyticsProvider";
import { logger } from "../../lib";
import { SignatureStatus, TransactionStatus, Address, ChainID } from "../../types";

// Type definitions that mirror Wagmi's types to maintain type safety
// These are defined to avoid runtime dependency when wagmi is not installed
interface UseSignMessageParameters {
  message?: string;
  mutation?: {
    onMutate?: (variables: any) => any;
    onSuccess?: (data: any, variables: any, context: any) => any;
    onError?: (error: any, variables: any, context: any) => any;
  };
}

interface UseSignMessageReturnType {
  signMessage: (args: { message: string }) => void;
  isPending?: boolean;
  error?: Error | null;
  data?: string;
}

interface UseSendTransactionParameters {
  to?: string;
  value?: bigint;
  data?: string;
  mutation?: {
    onMutate?: (variables: any) => any;
    onSuccess?: (data: any, variables: any, context: any) => any;
    onError?: (error: any, variables: any, context: any) => any;
  };
}

interface UseSendTransactionReturnType {
  sendTransaction: (args: { to: string; value?: bigint; data?: string }) => void;
  isPending?: boolean;
  error?: Error | null;
  data?: string;
}

interface UseAccountReturnType {
  address?: string;
  isConnected: boolean;
  connector?: {
    id?: string;
    name?: string;
  };
}

type UseChainIdReturnType = number | undefined;

// Dynamic imports for wagmi hooks - these will be undefined if wagmi is not installed
let useWagmiSignMessage: (parameters?: UseSignMessageParameters) => UseSignMessageReturnType;
let useWagmiSendTransaction: (parameters?: UseSendTransactionParameters) => UseSendTransactionReturnType;
let useWagmiAccount: () => UseAccountReturnType;
let useWagmiChainId: () => UseChainIdReturnType;

try {
  const wagmi = require("wagmi");
  useWagmiSignMessage = wagmi.useSignMessage;
  useWagmiSendTransaction = wagmi.useSendTransaction;
  useWagmiAccount = wagmi.useAccount;
  useWagmiChainId = wagmi.useChainId;
} catch (error) {
  // Wagmi is not installed - hooks will throw helpful errors
  useWagmiSignMessage = () => { 
    throw new Error("wagmi is not installed. Please install wagmi: npm install wagmi"); 
  };
  useWagmiSendTransaction = () => { 
    throw new Error("wagmi is not installed. Please install wagmi: npm install wagmi"); 
  };
  useWagmiAccount = () => { 
    throw new Error("wagmi is not installed. Please install wagmi: npm install wagmi"); 
  };
  useWagmiChainId = () => { 
    throw new Error("wagmi is not installed. Please install wagmi: npm install wagmi"); 
  };
}

/**
 * Drop-in replacement for Wagmi's useSignMessage with automatic Formo tracking
 * 
 * @example
 * ```tsx
 * // Just change the import - everything else stays the same!
 * import { useSignMessage } from '@formo/analytics/wagmi';
 * 
 * function Component() {
 *   const { signMessage, isPending, error } = useSignMessage();
 *   
 *   const handleSign = () => {
 *     signMessage({ message: "Hello World" });
 *     // Automatically tracks signature events!
 *   };
 * 
 *   return <button onClick={handleSign}>Sign Message</button>;
 * }
 * ```
 */
export function useSignMessage(parameters?: UseSignMessageParameters): UseSignMessageReturnType {
  if (!useWagmiSignMessage) {
    throw new Error("useSignMessage requires wagmi to be installed. Please install wagmi: npm install wagmi");
  }
  
  const formo = useFormo();
  const { address } = useWagmiAccount();
  const chainId = useWagmiChainId();
  
  const wagmiSignMessage = useWagmiSignMessage({
    ...parameters,
    mutation: {
      ...parameters?.mutation,
      onMutate: async (variables: any) => {
        // Track signature request
        if (formo && address) {
          try {
            await formo.signature({
              status: SignatureStatus.REQUESTED,
              address: address as Address,
              chainId: chainId as ChainID,
              message: variables.message,
            }, {
              source: "wagmi",
              method: "personal_sign",
            });
          } catch (error) {
            logger.error("Failed to track signature request", error);
          }
        }
        
        // Call original onMutate if provided
        return parameters?.mutation?.onMutate?.(variables);
      },
      onSuccess: async (data: any, variables: any, context: any) => {
        // Track signature confirmation
        if (formo && address) {
          try {
            await formo.signature({
              status: SignatureStatus.CONFIRMED,
              address: address as Address,
              chainId: chainId as ChainID,
              message: variables.message,
              signatureHash: data,
            }, {
              source: "wagmi",
              method: "personal_sign",
            });
          } catch (error) {
            logger.error("Failed to track signature confirmation", error);
          }
        }
        
        // Call original onSuccess if provided
        return parameters?.mutation?.onSuccess?.(data, variables, context);
      },
      onError: async (error: any, variables: any, context: any) => {
        // Track signature rejection
        if (formo && address) {
          try {
            await formo.signature({
              status: SignatureStatus.REJECTED,
              address: address as Address,
              chainId: chainId as ChainID,
              message: variables.message,
            }, {
              source: "wagmi",
              method: "personal_sign",
              error: error.message,
            });
          } catch (trackError) {
            logger.error("Failed to track signature rejection", trackError);
          }
        }
        
        // Call original onError if provided
        return parameters?.mutation?.onError?.(error, variables, context);
      },
    },
  });
  
  return wagmiSignMessage;
}

/**
 * Drop-in replacement for Wagmi's useSendTransaction with automatic Formo tracking
 * 
 * @example
 * ```tsx
 * // Just change the import - everything else stays the same!
 * import { useSendTransaction } from '@formo/analytics/wagmi';
 * 
 * function Component() {
 *   const { sendTransaction, isPending, error } = useSendTransaction();
 *   
 *   const handleSend = () => {
 *     sendTransaction({
 *       to: "0x...",
 *       value: parseEther("0.1"),
 *     });
 *     // Automatically tracks transaction events!
 *   };
 * 
 *   return <button onClick={handleSend}>Send Transaction</button>;
 * }
 * ```
 */
export function useSendTransaction(parameters?: UseSendTransactionParameters): UseSendTransactionReturnType {
  if (!useWagmiSendTransaction) {
    throw new Error("useSendTransaction requires wagmi to be installed. Please install wagmi: npm install wagmi");
  }
  
  const formo = useFormo();
  const { address } = useWagmiAccount();
  const chainId = useWagmiChainId();
  
  const wagmiSendTransaction = useWagmiSendTransaction({
    ...parameters,
    mutation: {
      ...parameters?.mutation,
      onMutate: async (variables: any) => {
        // Track transaction start
        if (formo && address) {
          try {
            await formo.transaction({
              status: TransactionStatus.STARTED,
              address: address as Address,
              chainId: chainId as ChainID,
              to: variables.to || "",
              value: variables.value?.toString() || "0",
              data: variables.data || "0x",
            }, {
              source: "wagmi",
            });
          } catch (error) {
            logger.error("Failed to track transaction start", error);
          }
        }
        
        // Call original onMutate if provided
        return parameters?.mutation?.onMutate?.(variables);
      },
      onSuccess: async (data: any, variables: any, context: any) => {
        // Track transaction broadcast
        if (formo && address) {
          try {
            await formo.transaction({
              status: TransactionStatus.BROADCASTED,
              address: address as Address,
              chainId: chainId as ChainID,
              to: variables.to || "",
              value: variables.value?.toString() || "0",
              data: variables.data || "0x",
              transactionHash: data,
            }, {
              source: "wagmi",
            });
          } catch (error) {
            logger.error("Failed to track transaction broadcast", error);
          }
        }
        
        // Call original onSuccess if provided
        return parameters?.mutation?.onSuccess?.(data, variables, context);
      },
      onError: async (error: any, variables: any, context: any) => {
        // Track transaction rejection
        if (formo && address) {
          try {
            await formo.transaction({
              status: TransactionStatus.REJECTED,
              address: address as Address,
              chainId: chainId as ChainID,
              to: variables.to || "",
              value: variables.value?.toString() || "0",
              data: variables.data || "0x",
            }, {
              source: "wagmi",
              error: error.message,
            });
          } catch (trackError) {
            logger.error("Failed to track transaction rejection", trackError);
          }
        }
        
        // Call original onError if provided
        return parameters?.mutation?.onError?.(error, variables, context);
      },
    },
  });
  
  return wagmiSendTransaction;
}

/**
 * Utility hook for manual wallet tracking (keeps original name for consistency)
 * 
 * @example
 * ```tsx
 * const { connectWithTracking, disconnectWithTracking } = useFormoWallet();
 * ```
 */
export function useFormoWallet() {
  if (!useWagmiAccount) {
    throw new Error("useFormoWallet requires wagmi to be installed. Please install wagmi: npm install wagmi");
  }
  
  const formo = useFormo();
  const { address, isConnected } = useWagmiAccount();
  const chainId = useWagmiChainId();
  
  const connectWithTracking = useCallback(async (
    _connector?: any,
    properties?: Record<string, unknown>
  ) => {
    if (!formo || !address || !chainId) return;
    
    try {
      await formo.connect(
        {
          address: address as Address,
          chainId: chainId as ChainID,
        },
        {
          ...properties,
          source: "wagmi",
          manual: true,
        }
      );
    } catch (error) {
      logger.error("Failed to track manual connection", error);
    }
  }, [formo, address, chainId]);
  
  const disconnectWithTracking = useCallback(async (
    properties?: Record<string, unknown>
  ) => {
    if (!formo) return;
    
    try {
      await formo.disconnect(
        {
          address: address as Address,
          chainId: chainId as ChainID,
        },
        {
          ...properties,
          source: "wagmi",
          manual: true,
        }
      );
    } catch (error) {
      logger.error("Failed to track manual disconnection", error);
    }
  }, [formo, address, chainId]);
  
  return {
    connectWithTracking,
    disconnectWithTracking,
    isConnected,
    address,
    chainId,
  };
}

