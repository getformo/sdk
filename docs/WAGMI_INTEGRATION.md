# Wagmi Integration for Formo Analytics

The Formo SDK now provides seamless integration with [Wagmi](https://wagmi.sh/) and [Porto](https://porto.sh/sdk), enabling automatic wallet event tracking with minimal setup for developers.

## Features

- ✅ **Automatic Event Tracking**: Connect, disconnect, chain changes, and address changes are tracked automatically
- ✅ **Enhanced Hooks**: Drop-in replacements for `useSignMessage` and `useSendTransaction` with built-in tracking
- ✅ **Type Safety**: Full TypeScript support with proper type inference
- ✅ **Minimal Setup**: Just wrap your app with `WagmiFormoProvider`
- ✅ **Debounced Events**: Handles rapid state changes gracefully
- ✅ **Error Handling**: Robust error handling and logging

## Quick Start

### 1. Installation

The Wagmi integration is included with the main Formo SDK package. Make sure you have Wagmi installed:

```bash
npm install @formo/analytics wagmi viem
```

### 2. Simple Setup

Use the `WagmiFormoProvider` that combines both Formo Analytics and Wagmi integration:

```tsx
import { WagmiProvider, createConfig } from 'wagmi';
import { mainnet, sepolia } from 'wagmi/chains';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiFormoProvider } from '@formo/analytics/wagmi';

const config = createConfig({
  chains: [mainnet, sepolia],
  // ... your wagmi config
});

const queryClient = new QueryClient();

function App() {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <WagmiFormoProvider writeKey="your-formo-write-key">
          <YourApp />
        </WagmiFormoProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
```

**Benefits:**
- ✅ Single provider setup
- ✅ Automatic Wagmi detection  
- ✅ Flexible provider layout
- ✅ Zero additional configuration

### 3. Automatic Event Tracking

Wallet events are automatically tracked:

- **Connect events** when users connect their wallet
- **Disconnect events** when users disconnect
- **Chain events** when users switch networks
- **Identify events** for connected wallets

## Drop-in Replacement Hooks

For existing Wagmi apps, the easiest way to add transaction and signature tracking is using drop-in replacement hooks. **Just change your import statements** - everything else stays the same!

### Migration Example

```tsx
// Before (Original Wagmi)
import { useSignMessage, useSendTransaction } from 'wagmi';

// After (With Formo Tracking)  
import { useSignMessage, useSendTransaction } from '@formo/analytics/wagmi';

// Your component code stays exactly the same!
function WalletComponent() {
  const { signMessage } = useSignMessage();
  const { sendTransaction } = useSendTransaction();
  
  // Same API, now with automatic event tracking!
}
```

### Supported Drop-in Hooks

### useSignMessage

Drop-in replacement for Wagmi's `useSignMessage` with automatic event tracking:

```tsx
import { useSignMessage } from '@formo/analytics/wagmi';

function SignMessageComponent() {
  const { signMessage, isPending, error } = useSignMessage();

  const handleSign = () => {
    signMessage({ 
      message: "Hello World" 
    });
    // Automatically tracks:
    // - signature.requested when user is prompted
    // - signature.confirmed when signed successfully  
    // - signature.rejected if user cancels
  };

  return (
    <button onClick={handleSign} disabled={isPending}>
      {isPending ? 'Signing...' : 'Sign Message'}
    </button>
  );
}
```

### useSendTransaction

Drop-in replacement for Wagmi's `useSendTransaction` with automatic event tracking:

```tsx
import { useSendTransaction } from '@formo/analytics/wagmi';
import { parseEther } from 'viem';

function SendTransactionComponent() {
  const { sendTransaction, isPending, error } = useSendTransaction();

  const handleSend = () => {
    sendTransaction({
      to: '0x742d35Cc6634C0532925a3b8D4B9E2C7C7b1e64e',
      value: parseEther('0.1'),
    });
    // Automatically tracks:
    // - transaction.started when user is prompted
    // - transaction.broadcasted when transaction is sent
    // - transaction.rejected if user cancels
  };

  return (
    <button onClick={handleSend} disabled={isPending}>
      {isPending ? 'Sending...' : 'Send 0.1 ETH'}
    </button>
  );
}
```

### Benefits of Drop-in Hooks

- ✅ **Zero API Changes** - Identical signatures to original Wagmi hooks
- ✅ **Minimal Migration** - Just change import statements
- ✅ **Full Compatibility** - Works with all existing Wagmi patterns
- ✅ **Automatic Tracking** - Events tracked without additional code
- ✅ **Type Safety** - Full TypeScript support with identical types

## Configuration Options

### WagmiFormoProvider Props

The provider accepts all standard Formo options plus Wagmi-specific configuration:

```tsx
interface WagmiFormoProviderProps extends FormoAnalyticsProviderProps {
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
```

Example with custom configuration:

```tsx
<WagmiFormoProvider 
  writeKey="your-key"
  enableWagmiIntegration={true}
  wagmiDebounceMs={200}
  options={{
    logger: { enabled: true },
    flushAt: 20,
    // ... other Formo options
  }}
>
  <YourApp />
</WagmiFormoProvider>
```

### WagmiFormoProvider Props (Separate Provider Approach)

```tsx
interface WagmiFormoProviderProps {
  children: ReactNode;
  /**
   * Enable automatic wallet event tracking
   * @default true
   */
  enableAutoTracking?: boolean;
  /**
   * Debounce time in ms for rapid state changes
   * @default 100
   */
  debounceMs?: number;
}
```

Example with custom configuration:

```tsx
<WagmiFormoProvider 
  enableAutoTracking={true}
  debounceMs={200}
>
  <YourApp />
</WagmiFormoProvider>
```

## Manual Tracking

If you need more control, you can use the `useFormoWallet` hook for manual tracking:

```tsx
import { useFormoWallet } from '@formo/analytics/wagmi';
import { useConnect, useDisconnect } from 'wagmi';

function ManualTrackingComponent() {
  const { connectWithTracking, disconnectWithTracking } = useFormoWallet();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();

  const handleConnect = async () => {
    await connect({ connector: connectors[0] });
    // Manually track with custom properties
    await connectWithTracking(connectors[0], {
      source: 'manual_button',
      campaign: 'onboarding'
    });
  };

  return (
    <button onClick={handleConnect}>
      Connect Wallet
    </button>
  );
}
```

## Event Data Structure

The integration automatically adds Wagmi-specific context to events:

```typescript
// Connect event from enhanced provider
{
  type: 'connect',
  address: '0x...',
  chainId: 1,
  properties: {
    providerName: 'MetaMask',
    connectorId: 'metaMask',
    source: 'wagmi'  // From WagmiFormoProvider
  }
}

// Transaction event from enhanced hooks
{
  type: 'transaction',
  status: 'started',
  address: '0x...',
  chainId: 1,
  to: '0x...',
  value: '100000000000000000',
  properties: {
    source: 'wagmi'  // From useFormoSendTransaction
  }
}
```

### Event Source Identification

Events are tagged with different sources to help you identify their origin:

| Source | Description | Origin |
|--------|-------------|--------|
| `wagmi` | Automatic events from provider | WagmiFormoProvider |
| `wagmi` | Events from enhanced hooks | useFormoSignMessage, useFormoSendTransaction |
| `wagmi-manual` | Manual tracking events | useFormoWallet |

This helps you distinguish between automatic and manual tracking in your analytics.

## Supported Connectors

The integration automatically maps Wagmi connector IDs to RDNS identifiers:

| Connector ID | RDNS | Provider |
|--------------|------|----------|
| `metaMask` | `io.metamask` | MetaMask |
| `walletConnect` | `com.walletconnect` | WalletConnect |
| `coinbaseWallet` | `com.coinbase.wallet` | Coinbase Wallet |
| `injected` | `io.injected.provider` | Generic Injected |
| `safe` | `io.gnosis.safe` | Gnosis Safe |
| `ledger` | `com.ledger` | Ledger |

## Best Practices

### 1. Provider Order

Always place `WagmiFormoProvider` inside `FormoAnalyticsProvider`:

```tsx
// ✅ Correct
<FormoAnalyticsProvider writeKey="...">
  <WagmiFormoProvider>
    <App />
  </WagmiFormoProvider>
</FormoAnalyticsProvider>

// ❌ Incorrect
<WagmiFormoProvider>
  <FormoAnalyticsProvider writeKey="...">
    <App />
  </FormoAnalyticsProvider>
</WagmiFormoProvider>
```

### 2. Error Handling

The integration includes built-in error handling, but you can add additional error tracking:

```tsx
const { signMessage, error } = useFormoSignMessage({
  mutation: {
    onError: (error) => {
      // Your custom error handling
      console.error('Signature failed:', error);
    }
  }
});
```

### 3. Performance

The integration uses debouncing to handle rapid state changes. Adjust `debounceMs` if needed:

```tsx
// For apps with frequent state changes
<WagmiFormoProvider debounceMs={300}>
  <App />
</WagmiFormoProvider>
```

## Troubleshooting

### Events Not Being Tracked

1. **Check provider order**: Ensure `WagmiFormoProvider` is inside `FormoAnalyticsProvider`
2. **Verify Formo initialization**: Check that your write key is correct
3. **Check console logs**: The integration logs important events for debugging

### Duplicate Events

1. **Multiple providers**: Ensure you only have one `WagmiFormoProvider` in your app
2. **Manual tracking**: Don't mix automatic and manual tracking for the same events

### TypeScript Issues

1. **Install types**: Make sure you have `@types/react` installed
2. **Wagmi version**: Ensure you're using a compatible version of Wagmi (v2.x)

## Migration from Direct Integration

If you were previously integrating with Wagmi manually, migration is straightforward:

### Before (Manual Integration)

```tsx
function App() {
  const { address, isConnected } = useAccount();
  const formo = useFormo();
  
  useEffect(() => {
    if (isConnected && address) {
      formo.connect({ address, chainId: 1 });
    }
  }, [isConnected, address]);
  
  // ... rest of app
}
```

### After (Automatic Integration)

```tsx
function App() {
  return (
    <WagmiFormoProvider>
      {/* Events are now tracked automatically */}
      <YourAppComponents />
    </WagmiFormoProvider>
  );
}
```

## Examples

Check out complete examples in the `/examples` directory:

- [Basic Wagmi Integration](../examples/wagmi-basic)
- [Advanced Usage with Custom Hooks](../examples/wagmi-advanced)
- [Next.js App with Wagmi + Formo](../examples/nextjs-wagmi)

## Support

For issues specific to the Wagmi integration:

1. Check the [troubleshooting section](#troubleshooting)
2. Review the [examples](../examples/)
3. Open an issue on [GitHub](https://github.com/getformo/sdk/issues)

For general Formo SDK questions, see the [main documentation](../README.md).
