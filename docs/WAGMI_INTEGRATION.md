# Wagmi Integration for Formo Analytics SDK

## Overview

The Formo Analytics SDK now supports optional integration with [Wagmi v2](https://wagmi.sh), a popular React Hooks library for Ethereum. This integration allows the SDK to track wallet events (connect, disconnect, chain changes, signatures, and transactions) by hooking into Wagmi's native event system instead of wrapping EIP-1193 providers.

## Design Philosophy

### Core Principles

1. **Opt-in Configuration**: Wagmi integration is completely optional and only activated when explicitly configured
2. **Replace, Don't Wrap**: When enabled, Wagmi mode replaces EIP-1193 provider wrapping entirely, avoiding conflicts
3. **Consistent Behavior**: Respects the same `autocapture` settings as the default EIP-1193 mode
4. **Clean Architecture**: Separates Wagmi-specific logic into dedicated modules for maintainability

### Why Wagmi Integration?

- **Native Event Handling**: Leverages Wagmi's built-in state management instead of intercepting provider methods
- **Better DX**: Works seamlessly with Wagmi's React hooks without modifying provider behavior
- **Type Safety**: Full TypeScript support with comprehensive type definitions
- **Performance**: Subscribes directly to Wagmi's state changes and TanStack Query's mutation cache
- **Reliability**: No proxy wrapping means fewer potential points of failure

## Architecture

### High-Level Flow

```
User's Wagmi Config + QueryClient
           ↓
    WagmiEventHandler
           ↓
    FormoAnalytics SDK
           ↓
    Analytics Events API
```

### Key Components

#### 1. **WagmiEventHandler** (`src/lib/wagmi/WagmiEventHandler.ts`)

The core orchestrator that hooks into Wagmi's event system:

- **Connection Tracking**: Subscribes to `config.subscribe()` for status and chainId changes
- **Mutation Tracking**: Subscribes to TanStack Query's MutationCache for signature and transaction events
- **Event Mapping**: Translates Wagmi state changes to Formo analytics events
- **Deduplication**: Prevents duplicate event emissions using mutation state tracking
- **Lifecycle Management**: Proper cleanup of all subscriptions

#### 2. **Type Definitions** (`src/lib/wagmi/types.ts`)

Comprehensive TypeScript interfaces for Wagmi integration:

- `WagmiConfig`: Wagmi configuration with subscribe methods
- `WagmiState`: Internal state structure (connections, chainId, status)
- `MutationCache`, `Mutation`, `MutationCacheEvent`: TanStack Query mutation tracking
- `WagmiTrackingState`: Internal tracking state management

#### 3. **FormoAnalytics Updates** (`src/FormoAnalytics.ts`)

Modified to support dual-mode operation:

- `isWagmiMode` flag to determine tracking mode
- `wagmiHandler` instance for Wagmi-specific event handling
- Skips EIP-1193 provider detection and wrapping when in Wagmi mode
- Public `isAutocaptureEnabled()` method for event filtering

## Event Mapping

### Connection Events

| Wagmi State | Formo Event | Details |
|------------|-------------|---------|
| `status: 'connected'` | `connect()` | Emitted when wallet connects with chainId and address |
| `status: 'disconnected'` | `disconnect()` | Emitted when wallet disconnects |
| `chainId` changes | `chain()` | Emitted when user switches networks |

### Mutation Events

| Wagmi Hook | Mutation Key | Formo Event | Status Mapping |
|-----------|--------------|-------------|----------------|
| `useSignMessage` | `signMessage` | `signature()` | pending → REQUESTED<br>success → CONFIRMED<br>error → REJECTED |
| `useSignTypedData` | `signTypedData` | `signature()` | pending → REQUESTED<br>success → CONFIRMED<br>error → REJECTED |
| `useSendTransaction` | `sendTransaction` | `transaction()` | pending → STARTED<br>success → BROADCASTED<br>error → REJECTED |
| `useWriteContract` | `writeContract` | `transaction()` | pending → STARTED<br>success → BROADCASTED<br>error → REJECTED |

## Usage

### Basic Setup

```typescript
import { createConfig } from 'wagmi';
import { QueryClient } from '@tanstack/react-query';
import { FormoAnalytics } from '@formo/analytics';

// Create Wagmi config
const wagmiConfig = createConfig({
  chains: [mainnet, polygon],
  transports: {
    [mainnet.id]: http(),
    [polygon.id]: http(),
  },
});

// Create QueryClient for mutation tracking
const queryClient = new QueryClient();

// Initialize Formo with Wagmi integration
const formo = await FormoAnalytics.init('YOUR_WRITE_KEY', {
  wagmi: {
    config: wagmiConfig,
    queryClient: queryClient, // Optional but required for signature/transaction tracking
  },
});
```

### With React

```tsx
import { WagmiProvider, createConfig } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FormoAnalyticsProvider } from '@formo/analytics';

const wagmiConfig = createConfig({ /* ... */ });
const queryClient = new QueryClient();

function App() {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <FormoAnalyticsProvider
          writeKey="YOUR_WRITE_KEY"
          options={{
            wagmi: {
              config: wagmiConfig,
              queryClient: queryClient,
            },
          }}
        >
          <YourApp />
        </FormoAnalyticsProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
```

### Autocapture Configuration

Control which events are tracked:

```typescript
const formo = await FormoAnalytics.init('YOUR_WRITE_KEY', {
  wagmi: {
    config: wagmiConfig,
    queryClient: queryClient,
  },
  autocapture: {
    connect: true,      // Track wallet connections
    disconnect: true,   // Track wallet disconnections
    chain: true,        // Track chain/network changes
    signature: true,    // Track message signing
    transaction: true,  // Track transactions
  },
});
```

### Cleanup

Always clean up when done:

```typescript
// In React component unmount or app cleanup
useEffect(() => {
  return () => {
    formo.cleanup();
  };
}, [formo]);
```

## Implementation Details

### Connection State Tracking

The handler subscribes to Wagmi's config state using two separate subscriptions:

1. **Status Subscription**: Monitors `state.status` for connect/disconnect events
2. **ChainId Subscription**: Monitors `state.chainId` for network changes

```typescript
config.subscribe(
  (state) => state.status,
  (status, prevStatus) => {
    // Handle connection state changes
  }
);

config.subscribe(
  (state) => state.chainId,
  (chainId, prevChainId) => {
    // Handle chain changes
  }
);
```

### Mutation Tracking with Deduplication

The handler subscribes to TanStack Query's mutation cache and implements deduplication:

```typescript
mutationCache.subscribe((event: MutationCacheEvent) => {
  // Track processed mutations to prevent duplicates
  const mutationStateKey = `${mutation.mutationId}:${state.status}`;
  
  if (processedMutations.has(mutationStateKey)) {
    return; // Skip duplicate
  }
  
  processedMutations.add(mutationStateKey);
  // Process mutation...
});
```

**Deduplication Strategy**:
- Uses a Set to track `mutationId:status` combinations
- Prevents the same state transition from being tracked multiple times
- Implements automatic cleanup (removes oldest entries when Set exceeds 1000 items)
- Clears completely on handler cleanup

### Address and Provider Detection

- **Address**: Extracted from `state.connections.get(state.current).accounts[0]`
- **ChainId**: Retrieved from `state.chainId`
- **Provider Name**: Retrieved from `state.connections.get(state.current).connector.name`

### Error Handling

All event handlers are wrapped in try-catch blocks with appropriate logging:

```typescript
try {
  await this.formo.connect({ chainId, address });
} catch (error) {
  logger.error("WagmiEventHandler: Error tracking connection:", error);
}
```

## Configuration Options

### WagmiOptions Interface

```typescript
interface WagmiOptions {
  /**
   * Wagmi config instance from createConfig()
   * Required for all Wagmi functionality
   */
  config: WagmiConfig;

  /**
   * Optional QueryClient instance from @tanstack/react-query
   * Required for tracking signature and transaction events via Wagmi's mutation system
   * If not provided, only connection/disconnection/chain events will be tracked
   */
  queryClient?: QueryClient;
}
```

### QueryClient: Optional but Recommended

#### Why is QueryClient Optional?

Wagmi uses **two separate event systems**:

1. **Connection State** (works without QueryClient)
   - Uses `wagmiConfig.subscribe()` for state changes
   - Tracks: Connect, disconnect, chain changes
   - Source: Wagmi's internal state store

2. **Mutation Events** (requires QueryClient)
   - Uses `queryClient.getMutationCache().subscribe()` for mutations
   - Tracks: Signatures and transactions
   - Source: TanStack Query mutation cache (used internally by Wagmi hooks)

#### Event Tracking with vs without QueryClient

| Event Type | Without QueryClient | With QueryClient |
|-----------|-------------------|------------------|
| Connect | ✅ Tracked | ✅ Tracked |
| Disconnect | ✅ Tracked | ✅ Tracked |
| Chain Change | ✅ Tracked | ✅ Tracked |
| Signatures | ❌ NOT Tracked | ✅ Tracked |
| Transactions | ❌ NOT Tracked | ✅ Tracked |

**Warning**: If `queryClient` is not provided, a warning will be logged: `"WagmiEventHandler: QueryClient not provided. Signature and transaction events will not be tracked via Wagmi."`

#### Recommended Setup

Since **TanStack Query is already a peer dependency of Wagmi** (Wagmi can't function without it), we **strongly recommend always providing the QueryClient** to get full event tracking:

```typescript
import { QueryClient } from '@tanstack/react-query';

// You already have this for Wagmi
const queryClient = new QueryClient();

// Provide it to Formo too
const formo = await FormoAnalytics.init('YOUR_WRITE_KEY', {
  wagmi: {
    config: wagmiConfig,
    queryClient: queryClient, // Recommended: enables full tracking
  },
});
```

**Best Practice**: Use the same QueryClient instance for both Wagmi and Formo to avoid creating multiple cache instances.

## Comparison: Wagmi Mode vs EIP-1193 Mode

| Feature | Wagmi Mode | EIP-1193 Mode |
|---------|-----------|---------------|
| **Provider Wrapping** | ❌ Not needed | ✅ Wraps `provider.request()` |
| **Event Source** | Wagmi config state | EIP-1193 provider events |
| **Mutation Tracking** | TanStack Query | Request interception |
| **Multi-Wallet Support** | Wagmi connectors (injected, WalletConnect, etc.) | EIP-6963 discovery |
| **Provider Discovery** | ❌ Skipped (uses Wagmi connectors) | ✅ EIP-6963 auto-detection |
| **React Integration** | Native with Wagmi | Provider-agnostic |
| **Setup Complexity** | Medium (requires Wagmi + TanStack Query) | Low (auto-detection) |
| **Type Safety** | Full TypeScript support | Full TypeScript support |

### How Wagmi Handles Multiple Wallets

**In Wagmi Mode:**
- Multi-wallet support is handled through **Wagmi's connector system**
- Each connector (MetaMask, WalletConnect, Coinbase Wallet) is configured in your Wagmi config
- When a user connects via a connector, Wagmi manages the provider instance
- The SDK tracks events by subscribing to Wagmi's state changes, not by detecting providers

**Example:**
```typescript
const wagmiConfig = createConfig({
  chains: [mainnet, polygon],
  connectors: [
    injected(),           // MetaMask, Brave, etc.
    walletConnect({ projectId }),  // WalletConnect
    coinbaseWallet({ appName: 'Your App' }), // Coinbase Wallet
  ],
  // ...
});
```

**In Non-Wagmi Mode (EIP-1193):**
- Multi-wallet support uses **EIP-6963** provider discovery
- The SDK listens for `eip6963:announceProvider` events
- Each discovered provider is tracked independently
- Works with any wallet that implements EIP-6963

**Key Difference**: Wagmi mode completely bypasses EIP-6963 and EIP-1193 provider tracking in favor of Wagmi's abstraction layer.

## Technical Considerations

### Memory Management

- **Subscription Cleanup**: All subscriptions are properly unsubscribed on cleanup
- **Mutation Tracking**: Set size is limited to 1000 entries with automatic pruning
- **State References**: No circular references or memory leaks

### Performance

- **Minimal Overhead**: Only subscribes to relevant state changes
- **Efficient Lookups**: Uses Set for O(1) duplicate detection
- **Lazy Initialization**: Handler only created when Wagmi config is provided

### Compatibility

- **Wagmi Version**: Requires Wagmi v2.0.0 or higher
- **TanStack Query**: Requires @tanstack/react-query v5.0.0 or higher (optional)
- **React Version**: Same as base SDK (>=16.14.0)

## Limitations

1. **Wagmi v2 Only**: Does not support Wagmi v1.x (different API)
2. **React Context Required**: Wagmi requires React context (not suitable for vanilla JS)
3. **No Mixed Mode**: Cannot use both Wagmi and EIP-1193 mode simultaneously
4. **Mutation Keys**: Depends on Wagmi's mutation key conventions (may break if Wagmi changes)

## Troubleshooting

### Events Not Being Tracked

**Check 1**: Ensure QueryClient is provided
```typescript
// ❌ Bad - missing QueryClient
wagmi: { config: wagmiConfig }

// ✅ Good
wagmi: { config: wagmiConfig, queryClient: queryClient }
```

**Check 2**: Verify autocapture settings
```typescript
autocapture: {
  signature: true,  // Must be true
  transaction: true, // Must be true
}
```

**Check 3**: Check console for warnings
```typescript
// Enable logging
options: {
  logger: {
    enabled: true,
    levels: ['info', 'warn', 'error', 'debug'],
  },
}
```

### Duplicate Events

This should not happen due to deduplication, but if it does:
- Check if you're initializing multiple Formo instances
- Verify cleanup is being called properly
- Check for multiple QueryClient instances

### Missing Address or ChainId

- Ensure wallet is fully connected before mutations
- Check that Wagmi state is properly initialized
- Verify connector is providing account information

## Testing

### Unit Testing

Mock the Wagmi config and QueryClient:

```typescript
import { WagmiEventHandler } from '@formo/analytics';

const mockConfig = {
  subscribe: jest.fn((selector, listener) => {
    // Return unsubscribe function
    return () => {};
  }),
  getState: jest.fn(() => ({
    status: 'connected',
    chainId: 1,
    connections: new Map(),
    current: 'mockConnector',
  })),
};

const mockQueryClient = {
  getMutationCache: jest.fn(() => ({
    subscribe: jest.fn(() => () => {}),
  })),
};

const handler = new WagmiEventHandler(
  formoInstance,
  mockConfig,
  mockQueryClient
);
```

### Integration Testing

Test with real Wagmi setup in a test environment:

```typescript
import { createConfig } from 'wagmi';
import { QueryClient } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';

// Set up test config and client
// Trigger wallet actions
// Verify events are emitted
```

## Future Enhancements

Potential improvements for future versions:

1. **Account Switching**: Track when user switches between multiple accounts
2. **Connector Info**: Include more detailed connector metadata
3. **Transaction Receipts**: Track transaction confirmations/reverts
4. **Custom Mutation Keys**: Support custom mutation key patterns
5. **Wagmi v3 Support**: When released, add support for next major version

## Migration Guide

### From EIP-1193 Mode to Wagmi Mode

If you're already using the SDK and want to switch to Wagmi:

**Before** (EIP-1193 mode):
```typescript
const formo = await FormoAnalytics.init('YOUR_WRITE_KEY', {
  // No wagmi config, uses EIP-1193 detection
});
```

**After** (Wagmi mode):
```typescript
import { createConfig } from 'wagmi';
import { QueryClient } from '@tanstack/react-query';

const wagmiConfig = createConfig({ /* ... */ });
const queryClient = new QueryClient();

const formo = await FormoAnalytics.init('YOUR_WRITE_KEY', {
  wagmi: {
    config: wagmiConfig,
    queryClient: queryClient,
  },
});
```

**Important**: Remove any manual event tracking code as Wagmi mode handles it automatically.

## Contributing

When contributing to Wagmi integration:

1. Maintain backward compatibility with EIP-1193 mode
2. Add tests for new event types
3. Update this documentation
4. Follow existing code patterns in `WagmiEventHandler.ts`
5. Ensure proper TypeScript types in `types.ts`

## Resources

- [Wagmi Documentation](https://wagmi.sh)
- [TanStack Query Documentation](https://tanstack.com/query)
- [Formo Analytics Documentation](https://docs.formo.so)
- [EIP-1193 Provider Specification](https://eips.ethereum.org/EIPS/eip-1193)

## Support

For issues or questions:
- Open an issue on [GitHub](https://github.com/getformo/sdk)
- Join [Formo Community Slack](https://formo.so/slack)
- Check [Developer Docs](https://docs.formo.so)

