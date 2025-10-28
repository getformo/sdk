import { ReactNode, useEffect, useRef } from "react";
import { FormoAnalyticsProvider, useFormo } from "../../FormoAnalyticsProvider";
import { FormoAnalyticsProviderProps } from "../../types";
import { logger } from "../../lib";
import { Address, ChainID } from "../../types";

// Dynamic imports for wagmi hooks - these will be undefined if wagmi is not installed
let useAccount: any;
let useChainId: any;
let useConnectorClient: any;
let useConfig: any;

try {
  const wagmi = require("wagmi");
  useAccount = wagmi.useAccount;
  useChainId = wagmi.useChainId;
  useConnectorClient = wagmi.useConnectorClient;
  useConfig = wagmi.useConfig;
} catch (error) {
  // Wagmi is not installed - will fall back to regular FormoAnalyticsProvider
}

export interface WagmiFormoProviderProps extends FormoAnalyticsProviderProps {
  /**
   * Enable automatic Wagmi integration if Wagmi context is detected
   * @default true
   */
  enableWagmiIntegration?: boolean;
  /**
   * Debounce time in ms for rapid wallet state changes
   * @default 100
   */
  wagmiDebounceMs?: number;
}

/**
 * WagmiFormoProvider with automatic Wagmi integration
 * 
 * This provider combines FormoAnalyticsProvider with automatic Wagmi detection.
 * If a Wagmi context is found, it will automatically track wallet events.
 * 
 * @example Simple Usage
 * ```tsx
 * <WagmiProvider config={wagmiConfig}>
 *   <WagmiFormoProvider writeKey="your-key">
 *     <App />
 *   </WagmiFormoProvider>
 * </WagmiProvider>
 * ```
 * 
 * @example With Custom Options
 * ```tsx
 * <WagmiProvider config={wagmiConfig}>
 *   <WagmiFormoProvider 
 *     writeKey="your-key"
 *     enableWagmiIntegration={true}
 *     wagmiDebounceMs={200}
 *     options={{ logger: { enabled: true } }}
 *   >
 *     <App />
 *   </WagmiFormoProvider>
 * </WagmiProvider>
 * ```
 */
export function WagmiFormoProvider({
  enableWagmiIntegration = true,
  wagmiDebounceMs = 100,
  ...formoProps
}: WagmiFormoProviderProps) {
  const { children, ...restFormoProps } = formoProps;
  
  return (
    <FormoAnalyticsProvider {...restFormoProps}>
      {enableWagmiIntegration && useAccount ? (
        <WagmiIntegrationBridge debounceMs={wagmiDebounceMs}>
          {children}
        </WagmiIntegrationBridge>
      ) : (
        children
      )}
    </FormoAnalyticsProvider>
  );
}

/**
 * Internal component that handles Wagmi integration when Wagmi context is available
 */
function WagmiIntegrationBridge({ 
  children, 
  debounceMs = 100 
}: { 
  children: ReactNode; 
  debounceMs?: number; 
}) {
  // This will only be called if useAccount exists (Wagmi is available)
  const { address, isConnected, connector } = useAccount();
  const chainId = useChainId();
  const { data: connectorClient } = useConnectorClient();
  const config = useConfig();
  
  const formo = useFormo();
  
  // Track previous state to detect changes
  const prevState = useRef<{
    address?: Address;
    isConnected: boolean;
    chainId?: ChainID;
    connectorId?: string;
  }>({
    address: undefined,
    isConnected: false,
    chainId: undefined,
    connectorId: undefined,
  });
  
  // Debounce timer
  const debounceTimer = useRef<NodeJS.Timeout>();
  
  useEffect(() => {
    if (!formo) return;
    
    // Clear existing timer
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
    }
    
    // Debounce rapid state changes
    debounceTimer.current = setTimeout(() => {
      handleWalletStateChange();
    }, debounceMs);
    
    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
    };
  }, [address, isConnected, chainId, connector?.id, formo, debounceMs]);
  
  const handleWalletStateChange = async () => {
    if (!formo) return;
    
    const currentState = {
      address: address as Address | undefined,
      isConnected,
      chainId: chainId as ChainID | undefined,
      connectorId: connector?.id,
    };
    
    const prev = prevState.current;
    
    try {
      // Handle connection events
      if (!prev.isConnected && currentState.isConnected && currentState.address && currentState.chainId) {
        logger.info("WagmiFormoProvider: Wallet connected", {
          address: currentState.address,
          chainId: currentState.chainId,
          connector: currentState.connectorId
        });
        
        await formo.connect(
          {
            address: currentState.address,
            chainId: currentState.chainId,
          },
          {
            providerName: connector?.name || "Unknown",
            connectorId: currentState.connectorId,
            source: "wagmi",
          }
        );
        
        // Auto-identify the connected wallet
        await formo.identify(
          {
            address: currentState.address,
            providerName: connector?.name || "Unknown",
            rdns: getConnectorRdns(connector?.id),
          },
          {
            source: "wagmi",
            connectorId: currentState.connectorId,
          }
        );
      }
      
      // Handle disconnection events
      if (prev.isConnected && !currentState.isConnected) {
        logger.info("WagmiFormoProvider: Wallet disconnected", {
          previousAddress: prev.address,
          previousChainId: prev.chainId
        });
        
        await formo.disconnect(
          {
            address: prev.address,
            chainId: prev.chainId,
          },
          {
            providerName: connector?.name || "Unknown",
            connectorId: prev.connectorId,
            source: "wagmi",
          }
        );
      }
      
      // Handle chain change events (only for connected wallets)
      if (
        currentState.isConnected &&
        prev.isConnected &&
        currentState.chainId &&
        prev.chainId !== currentState.chainId &&
        currentState.address
      ) {
        logger.info("WagmiFormoProvider: Chain changed", {
          from: prev.chainId,
          to: currentState.chainId,
          address: currentState.address
        });
        
        await formo.chain(
          {
            chainId: currentState.chainId,
            address: currentState.address,
          },
          {
            previousChainId: prev.chainId,
            providerName: connector?.name || "Unknown",
            connectorId: currentState.connectorId,
            source: "wagmi",
          }
        );
      }
      
      // Handle address change events (wallet switch within same connector)
      if (
        currentState.isConnected &&
        prev.isConnected &&
        currentState.address &&
        prev.address &&
        prev.address !== currentState.address &&
        currentState.chainId
      ) {
        logger.info("WagmiFormoProvider: Address changed", {
          from: prev.address,
          to: currentState.address,
          chainId: currentState.chainId
        });
        
        // Emit disconnect for old address
        await formo.disconnect(
          {
            address: prev.address,
            chainId: prev.chainId || currentState.chainId,
          },
          {
            reason: "address_change",
            providerName: connector?.name || "Unknown",
            source: "wagmi",
          }
        );
        
        // Emit connect for new address
        await formo.connect(
          {
            address: currentState.address,
            chainId: currentState.chainId,
          },
          {
            reason: "address_change",
            providerName: connector?.name || "Unknown",
            connectorId: currentState.connectorId,
            source: "wagmi",
          }
        );
        
        // Auto-identify the new address
        await formo.identify(
          {
            address: currentState.address,
            providerName: connector?.name || "Unknown",
            rdns: getConnectorRdns(connector?.id),
          },
          {
            reason: "address_change",
            source: "wagmi",
            connectorId: currentState.connectorId,
          }
        );
      }
      
    } catch (error) {
      logger.error("WagmiFormoProvider: Error handling wallet state change", error);
    }
    
    // Update previous state
    prevState.current = currentState;
  };
  
  return <>{children}</>;
}

/**
 * Maps Wagmi connector IDs to their corresponding RDNS identifiers
 */
function getConnectorRdns(connectorId?: string): string {
  const rdnsMap: Record<string, string> = {
    'metaMask': 'io.metamask',
    'walletConnect': 'com.walletconnect',
    'coinbaseWallet': 'com.coinbase.wallet',
    'injected': 'io.injected.provider',
    'safe': 'io.gnosis.safe',
    'ledger': 'com.ledger',
  };
  
  return rdnsMap[connectorId || ''] || 'io.unknown.connector';
}

