/**
 * Example: Using excludeChains to control tracking on specific chains
 * 
 * This example demonstrates how to use the excludeChains configuration
 * to prevent tracking of events on specific blockchain networks while
 * still capturing chain transition events for analytics.
 */

import { FormoAnalytics } from '../src';

async function initializeAnalytics() {
  // Initialize Formo Analytics with excludeChains configuration
  const analytics = await FormoAnalytics.init('your-write-key', {
    tracking: {
      // Exclude Monad testnet and any staging chains
      excludeChains: [
        41455,  // Monad testnet
        31337,  // Hardhat local chain
        1337,   // Ganache local chain
      ],
      // Optionally exclude specific hosts
      excludeHosts: [
        'localhost',
        'staging.example.com'
      ],
      // Optionally exclude specific paths
      excludePaths: [
        '/admin',
        '/test'
      ]
    },
    // Enable logging to see what's being tracked
    logger: {
      enabled: true,
      levels: ['info', 'warn', 'error']
    }
  });

  return analytics;
}

/**
 * Example 1: Normal chain switching behavior
 * 
 * This demonstrates what events are tracked when switching between chains
 */
async function exampleChainSwitching() {
  const analytics = await initializeAnalytics();
  
  // Scenario: User starts on Ethereum mainnet
  console.log('User connects on Ethereum (Chain 1)');
  await analytics.connect({
    chainId: 1,
    address: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e'
  });
  // ✅ Connect event is tracked (chain 1 is not excluded)
  
  // User performs a transaction
  console.log('User sends transaction on Ethereum');
  await analytics.transaction({
    status: 'started',
    chainId: 1,
    address: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
    to: '0x123...',
    value: '1000000000000000000', // 1 ETH
  });
  // ✅ Transaction event is tracked (chain 1 is not excluded)
  
  // User switches to Monad testnet (excluded)
  console.log('User switches to Monad testnet (Chain 41455)');
  // This would typically happen through wallet UI, which triggers chainChanged event
  // The SDK automatically detects and handles this
  // ✅ Chain transition event IS tracked (transitions are always tracked)
  // Event will include: { chainId: 41455, previousChainId: 1 }
  
  // User performs a transaction on Monad
  console.log('User tries transaction on Monad');
  await analytics.transaction({
    status: 'started',
    chainId: 41455,
    address: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
    to: '0x456...',
    value: '5000000000000000000', // 5 MONAD
  });
  // ❌ Transaction event is NOT tracked (chain 41455 is excluded)
  // You'll see log: "Skipping transaction on excluded chain 41455"
  
  // User switches back to Ethereum
  console.log('User switches back to Ethereum');
  // ✅ Chain transition event IS tracked
  // Event will include: { chainId: 1, previousChainId: 41455 }
  
  // User performs another transaction on Ethereum
  console.log('User sends another transaction on Ethereum');
  await analytics.transaction({
    status: 'started',
    chainId: 1,
    address: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
    to: '0x789...',
    value: '2000000000000000000', // 2 ETH
  });
  // ✅ Transaction event is tracked (back on non-excluded chain)
}

/**
 * Example 2: Programmatic chain exclusion check
 * 
 * This shows how the exclusion logic works internally
 */
async function exampleExclusionLogic() {
  const analytics = await initializeAnalytics();
  
  // The SDK automatically checks if events should be tracked
  // based on the current or event-specific chain ID
  
  // When tracking events, the SDK:
  // 1. Extracts chainId from event payload
  // 2. Checks if chainId is in excludeChains array
  // 3. For CHAIN events: always tracks (captures transitions)
  // 4. For other events: skips if chain is excluded
  
  console.log('Internal tracking flow:');
  console.log('1. Event: transaction on chain 1');
  console.log('   -> shouldTrack(TRANSACTION, 1) -> true');
  console.log('   -> Event is sent');
  
  console.log('2. Event: transaction on chain 41455');
  console.log('   -> shouldTrack(TRANSACTION, 41455) -> false');
  console.log('   -> Event is skipped');
  
  console.log('3. Event: chain change to 41455');
  console.log('   -> shouldTrack(CHAIN, 41455) -> true (special case)');
  console.log('   -> Event is sent with previousChainId');
}

/**
 * Example 3: Dynamic configuration
 * 
 * This shows how to work with the tracking configuration
 */
async function exampleDynamicConfiguration() {
  // You can also disable all tracking with a boolean
  const analyticsDisabled = await FormoAnalytics.init('your-write-key', {
    tracking: false  // Completely disable tracking
  });
  
  // Or enable all tracking
  const analyticsEnabled = await FormoAnalytics.init('your-write-key', {
    tracking: true  // Track everything
  });
  
  // Or use granular exclusions (recommended)
  const analyticsGranular = await FormoAnalytics.init('your-write-key', {
    tracking: {
      excludeChains: [41455],
      // If any exclusion arrays are empty or omitted, they don't filter anything
      excludeHosts: [],  // Track on all hosts
      excludePaths: []   // Track on all paths
    }
  });
  
  // Default behavior (if tracking option is not provided)
  const analyticsDefault = await FormoAnalytics.init('your-write-key');
  // By default: tracks everywhere except localhost
}

/**
 * Example 4: Analyzing chain transition data
 * 
 * This shows what analytics data you'll receive
 */
async function exampleAnalyticsData() {
  const analytics = await initializeAnalytics();
  
  // When users switch chains, you'll receive events like:
  
  /*
  {
    "type": "chain",
    "chainId": 41455,
    "address": "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
    "properties": {
      "previousChainId": 1,
      "providerName": "MetaMask",
      "rdns": "io.metamask"
    },
    "timestamp": "2025-10-24T12:34:56.789Z",
    "anonymousId": "...",
    "messageId": "..."
  }
  */
  
  // This data allows you to analyze:
  // - Which chains users visit
  // - How often users switch between chains
  // - Common chain switching patterns
  // - User journey across different networks
  // - Entry/exit points for specific chains
  
  console.log('Analytics insights you can derive:');
  console.log('- "Users spent 5 minutes on Monad before switching back"');
  console.log('- "30% of users tried Monad testnet"');
  console.log('- "Most common pattern: Ethereum -> Monad -> Polygon"');
  console.log('- "Average number of chain switches per session: 2.3"');
}

/**
 * Example 5: Best practices
 */
async function bestPractices() {
  // ✅ DO: Exclude test/staging chains
  const analytics = await FormoAnalytics.init('your-write-key', {
    tracking: {
      excludeChains: [
        31337,  // Hardhat
        1337,   // Ganache
        // Add any testnet chains you don't want to track
      ]
    }
  });
  
  // ✅ DO: Use specific chain IDs (decimal format)
  const analyticsGood = await FormoAnalytics.init('your-write-key', {
    tracking: {
      excludeChains: [1337, 31337]  // Clear and specific
    }
  });
  
  // ❌ DON'T: Exclude production chains unless you have a specific reason
  const analyticsBad = await FormoAnalytics.init('your-write-key', {
    tracking: {
      excludeChains: [1, 137, 56]  // Don't exclude mainnet chains!
    }
  });
  
  // ✅ DO: Combine with other exclusion rules
  const analyticsCombined = await FormoAnalytics.init('your-write-key', {
    tracking: {
      excludeChains: [31337],
      excludeHosts: ['localhost', 'staging.example.com'],
      excludePaths: ['/admin', '/internal']
    }
  });
  
  // ✅ DO: Enable logging during development
  const analyticsDebug = await FormoAnalytics.init('your-write-key', {
    tracking: {
      excludeChains: [41455]
    },
    logger: {
      enabled: true,
      levels: ['info', 'warn', 'error']
    }
  });
}

// Run examples
async function main() {
  console.log('=== Example 1: Chain Switching ===');
  await exampleChainSwitching();
  
  console.log('\n=== Example 2: Exclusion Logic ===');
  await exampleExclusionLogic();
  
  console.log('\n=== Example 3: Dynamic Configuration ===');
  await exampleDynamicConfiguration();
  
  console.log('\n=== Example 4: Analytics Data ===');
  await exampleAnalyticsData();
  
  console.log('\n=== Example 5: Best Practices ===');
  await bestPractices();
}

// Uncomment to run:
// main().catch(console.error);

export {
  initializeAnalytics,
  exampleChainSwitching,
  exampleExclusionLogic,
  exampleDynamicConfiguration,
  exampleAnalyticsData,
  bestPractices
};

