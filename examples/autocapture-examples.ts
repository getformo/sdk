/**
 * Wallet Autocapture Configuration Examples
 * 
 * This file demonstrates various ways to configure wallet event autocapture
 * in the Formo SDK. Choose the configuration that best fits your use case.
 */

import { FormoAnalytics, AutocaptureOptions } from '@formo/analytics';

// ============================================================================
// Example 1: Default Behavior (All Events Enabled)
// ============================================================================

/**
 * By default, all wallet events are automatically tracked.
 * No configuration needed.
 */
async function example1_DefaultBehavior() {
  const analytics = await FormoAnalytics.init('YOUR_WRITE_KEY');
  
  // Result: All wallet events (connect, disconnect, signature, transaction, chain) are tracked
  console.log('Example 1: All wallet events are being tracked');
}

// ============================================================================
// Example 2: Disable All Wallet Autocapture
// ============================================================================

/**
 * Completely disable all automatic wallet event tracking.
 * Use this when you want full manual control over event tracking.
 */
async function example2_DisableAllAutocapture() {
  const analytics = await FormoAnalytics.init('YOUR_WRITE_KEY', {
    autocapture: false
  });
  
  // Result: No wallet events are tracked automatically
  // You can still manually track events:
  // await analytics.connect({ chainId: 1, address: '0x...' });
  console.log('Example 2: Wallet autocapture disabled - manual tracking only');
}

// ============================================================================
// Example 3: Track Only Wallet Connections
// ============================================================================

/**
 * Perfect for apps that only need to know when users connect/disconnect
 * their wallets, without tracking signatures or transactions.
 */
async function example3_ConnectionsOnly() {
  const analytics = await FormoAnalytics.init('YOUR_WRITE_KEY', {
    autocapture: {
      enabled: true,
      events: {
        connect: true,
        disconnect: true,
        signature: false,
        transaction: false,
        chain: false
      }
    }
  });
  
  // Result: Only connect and disconnect events are tracked
  console.log('Example 3: Tracking only wallet connections and disconnections');
}

// ============================================================================
// Example 4: DeFi App - Focus on Transactions
// ============================================================================

/**
 * Ideal for DeFi applications where transactions are the primary concern.
 * Tracks connections, transactions, and chain changes.
 */
async function example4_DeFiFocus() {
  const analytics = await FormoAnalytics.init('YOUR_WRITE_KEY', {
    autocapture: {
      enabled: true,
      events: {
        connect: true,      // Track when users connect
        disconnect: true,   // Track when users disconnect
        signature: false,   // Don't track signatures
        transaction: true,  // Track all transactions
        chain: true         // Track network switches
      }
    }
  });
  
  console.log('Example 4: DeFi-optimized tracking (transactions + connections + chains)');
}

// ============================================================================
// Example 5: NFT Marketplace - Signatures Matter
// ============================================================================

/**
 * For NFT marketplaces where signatures are important for listings,
 * offers, and bids.
 */
async function example5_NFTMarketplace() {
  const analytics = await FormoAnalytics.init('YOUR_WRITE_KEY', {
    autocapture: {
      enabled: true,
      events: {
        connect: true,
        disconnect: true,
        signature: true,    // Track all signatures
        transaction: true,  // Track all transactions
        chain: false        // Chain changes less important
      }
    }
  });
  
  console.log('Example 5: NFT marketplace tracking (signatures + transactions + connections)');
}

// ============================================================================
// Example 6: Reduce Noise - Disable Signatures Only
// ============================================================================

/**
 * For applications with many signature requests (e.g., permit2, gasless txs)
 * where signature tracking creates too much noise in analytics.
 */
async function example6_ReduceSignatureNoise() {
  const analytics = await FormoAnalytics.init('YOUR_WRITE_KEY', {
    autocapture: {
      enabled: true,
      events: {
        connect: true,
        disconnect: true,
        signature: false,   // Disable signature tracking
        transaction: true,
        chain: true
      }
    }
  });
  
  console.log('Example 6: All events except signatures');
}

// ============================================================================
// Example 7: Multi-Chain App - Chain Tracking Priority
// ============================================================================

/**
 * For multi-chain applications where tracking chain switches is crucial
 * for understanding user behavior across networks.
 */
async function example7_MultiChainFocus() {
  const analytics = await FormoAnalytics.init('YOUR_WRITE_KEY', {
    autocapture: {
      enabled: true,
      events: {
        connect: true,
        disconnect: true,
        signature: false,
        transaction: true,
        chain: true         // Critical for multi-chain apps
      }
    }
  });
  
  console.log('Example 7: Multi-chain focused tracking');
}

// ============================================================================
// Example 8: TypeScript - Using Type-Safe Configuration
// ============================================================================

/**
 * Demonstrates type-safe configuration using TypeScript.
 */
async function example8_TypeScript() {
  // Define config with full type safety
  const config: AutocaptureOptions = {
    enabled: true,
    events: {
      connect: true,
      disconnect: true,
      signature: false,
      transaction: true,
      chain: true
    }
  };
  
  const analytics = await FormoAnalytics.init('YOUR_WRITE_KEY', {
    autocapture: config
  });
  
  console.log('Example 8: Type-safe configuration');
}

// ============================================================================
// Example 9: Partial Configuration (Defaults Apply)
// ============================================================================

/**
 * You can specify only the events you want to disable.
 * Unspecified events default to enabled.
 */
async function example9_PartialConfiguration() {
  const analytics = await FormoAnalytics.init('YOUR_WRITE_KEY', {
    autocapture: {
      enabled: true,
      events: {
        signature: false    // Disable only signatures
        // connect, disconnect, transaction, chain all default to true
      }
    }
  });
  
  console.log('Example 9: Partial configuration - only signature disabled');
}

// ============================================================================
// Example 10: Environment-Based Configuration
// ============================================================================

/**
 * Different tracking configurations for different environments.
 */
async function example10_EnvironmentBased() {
  const isDevelopment = process.env.NODE_ENV === 'development';
  const isProduction = process.env.NODE_ENV === 'production';
  
  const analytics = await FormoAnalytics.init('YOUR_WRITE_KEY', {
    // Disable tracking in development
    tracking: isProduction,
    
    // In production, track only important events
    autocapture: isProduction ? {
      enabled: true,
      events: {
        connect: true,
        disconnect: true,
        signature: false,    // Too noisy for production
        transaction: true,
        chain: true
      }
    } : false
  });
  
  console.log(`Example 10: Environment-based (${process.env.NODE_ENV})`);
}

// ============================================================================
// Example 11: React Component with Configuration
// ============================================================================

/**
 * Using wallet autocapture configuration in a React application.
 */
import { FormoAnalyticsProvider } from '@formo/analytics';
import React from 'react';

function Example11_ReactApp() {
  return (
    <FormoAnalyticsProvider
      writeKey="YOUR_WRITE_KEY"
      options={{
        autocapture: {
          enabled: true,
          events: {
            connect: true,
            disconnect: true,
            signature: false,
            transaction: true,
            chain: true
          }
        },
        logger: {
          enabled: true,
          levels: ['error', 'warn']
        }
      }}
    >
      {/* Your app components */}
    </FormoAnalyticsProvider>
  );
}

// ============================================================================
// Example 12: Next.js App Router
// ============================================================================

/**
 * Using wallet autocapture in Next.js App Router layout.
 */

// app/layout.tsx
export function Example12_NextJsAppRouter({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <FormoAnalyticsProvider
          writeKey={process.env.NEXT_PUBLIC_FORMO_WRITE_KEY!}
          options={{
            autocapture: {
              enabled: true,
              events: {
                connect: true,
                disconnect: true,
                signature: false,
                transaction: true,
                chain: true
              }
            }
          }}
        >
          {children}
        </FormoAnalyticsProvider>
      </body>
    </html>
  );
}

// ============================================================================
// Example 13: Combining with Other Options
// ============================================================================

/**
 * Wallet autocapture works seamlessly with other SDK options.
 */
async function example13_CombinedOptions() {
  const analytics = await FormoAnalytics.init('YOUR_WRITE_KEY', {
    // Wallet autocapture configuration
    autocapture: {
      enabled: true,
      events: {
        connect: true,
        disconnect: true,
        signature: false,
        transaction: true,
        chain: true
      }
    },
    
    // Tracking configuration
    tracking: {
      excludeHosts: ['localhost', 'staging.example.com'],
      excludeChains: [5] // Exclude Goerli testnet
    },
    
    // Batching configuration
    flushAt: 20,
    flushInterval: 60000,
    
    // Logging configuration
    logger: {
      enabled: true,
      levels: ['error', 'warn', 'info']
    },
    
    // Ready callback
    ready: (formo) => {
      console.log('Formo SDK initialized and ready!');
      formo.identify(); // Auto-identify user
    }
  });
  
  console.log('Example 13: Combined with other SDK options');
}

// ============================================================================
// Example 14: Manual Tracking Override
// ============================================================================

/**
 * Even with autocapture disabled, you can still manually track events.
 */
async function example14_ManualOverride() {
  const analytics = await FormoAnalytics.init('YOUR_WRITE_KEY', {
    autocapture: false  // Disable all autocapture
  });
  
  // Manually track a connection when you want
  await analytics.connect({
    chainId: 1,
    address: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e'
  });
  
  // Manually track a transaction
  await analytics.transaction({
    status: 'broadcasted',
    chainId: 1,
    address: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
    transactionHash: '0x...'
  });
  
  console.log('Example 14: Manual tracking with autocapture disabled');
}

// ============================================================================
// Example 15: Testing Configuration
// ============================================================================

/**
 * Disable wallet tracking in test environments.
 */
async function example15_Testing() {
  const isTestEnvironment = process.env.NODE_ENV === 'test';
  
  const analytics = await FormoAnalytics.init('YOUR_WRITE_KEY', {
    // Disable all tracking in tests
    tracking: !isTestEnvironment,
    autocapture: !isTestEnvironment
  });
  
  console.log('Example 15: Test environment configuration');
}

// ============================================================================
// Example 16: Progressive Enhancement
// ============================================================================

/**
 * Start with minimal tracking and progressively enable more based on user behavior.
 */
async function example16_ProgressiveEnhancement() {
  // Start with basic tracking
  let analytics = await FormoAnalytics.init('YOUR_WRITE_KEY', {
    autocapture: {
      enabled: true,
      events: {
        connect: true,
        disconnect: true,
        signature: false,
        transaction: false,
        chain: false
      }
    }
  });
  
  // Later, if user performs a transaction, you can manually track it
  // even though autocapture for transactions is disabled
  async function onUserTransaction(txHash: string) {
    await analytics.transaction({
      status: 'broadcasted',
      chainId: 1,
      address: '0x...',
      transactionHash: txHash
    });
  }
  
  console.log('Example 16: Progressive enhancement approach');
}

// ============================================================================
// Export all examples for documentation
// ============================================================================

export const examples = {
  example1_DefaultBehavior,
  example2_DisableAllAutocapture,
  example3_ConnectionsOnly,
  example4_DeFiFocus,
  example5_NFTMarketplace,
  example6_ReduceSignatureNoise,
  example7_MultiChainFocus,
  example8_TypeScript,
  example9_PartialConfiguration,
  example10_EnvironmentBased,
  example11_ReactApp: Example11_ReactApp,
  example12_NextJsAppRouter: Example12_NextJsAppRouter,
  example13_CombinedOptions,
  example14_ManualOverride,
  example15_Testing,
  example16_ProgressiveEnhancement,
};

// ============================================================================
// Usage Guide
// ============================================================================

/**
 * QUICK START GUIDE:
 * 
 * 1. Identify Your Needs:
 *    - What wallet events are critical for your analytics?
 *    - Are there events creating unnecessary noise?
 *    - Do you need real-time tracking or can you track manually?
 * 
 * 2. Choose Your Configuration:
 *    - Default: Track everything (no config needed)
 *    - Minimal: Track only connections (Example 3)
 *    - DeFi: Track transactions + connections (Example 4)
 *    - NFT: Track signatures + transactions (Example 5)
 *    - Custom: Mix and match based on your needs
 * 
 * 3. Test Thoroughly:
 *    - Verify events are being tracked correctly
 *    - Check that disabled events are not creating noise
 *    - Ensure manual tracking works if autocapture is disabled
 * 
 * 4. Monitor & Adjust:
 *    - Review your analytics to see if you're capturing what you need
 *    - Adjust configuration based on actual usage patterns
 *    - Consider enabling/disabling events as your app evolves
 */

