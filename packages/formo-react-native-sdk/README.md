# @formo/react-native-analytics

Formo Analytics SDK for React Native - Track wallet events and user analytics in mobile dApps.

## Installation

```bash
npm install @formo/react-native-analytics @react-native-async-storage/async-storage

# or with yarn
yarn add @formo/react-native-analytics @react-native-async-storage/async-storage

# or with pnpm
pnpm add @formo/react-native-analytics @react-native-async-storage/async-storage
```

### iOS Setup

```bash
cd ios && pod install
```

## Quick Start

### 1. Wrap your app with the provider

```tsx
import AsyncStorage from '@react-native-async-storage/async-storage';
import { FormoAnalyticsProvider } from '@formo/react-native-analytics';

function App() {
  return (
    <FormoAnalyticsProvider
      writeKey="your-write-key"
      asyncStorage={AsyncStorage}
      options={{
        app: {
          name: 'MyApp',
          version: '1.0.0',
        },
      }}
    >
      <YourApp />
    </FormoAnalyticsProvider>
  );
}
```

### 2. Use the hook in your components

```tsx
import { useFormo } from '@formo/react-native-analytics';
import { useEffect } from 'react';

function HomeScreen() {
  const formo = useFormo();

  useEffect(() => {
    // Track screen view
    formo.screen('Home');
  }, []);

  const handleSignUp = () => {
    // Track custom event
    formo.track('Sign Up Button Pressed', {
      screen: 'Home',
    });
  };

  return <Button onPress={handleSignUp}>Sign Up</Button>;
}
```

## Wagmi Integration

For dApps using Wagmi for wallet connections, you can enable automatic wallet event tracking:

```tsx
import { QueryClient } from '@tanstack/react-query';
import { createConfig } from 'wagmi';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { FormoAnalyticsProvider } from '@formo/react-native-analytics';

const queryClient = new QueryClient();
const wagmiConfig = createConfig({
  // your wagmi config
});

function App() {
  return (
    <FormoAnalyticsProvider
      writeKey="your-write-key"
      asyncStorage={AsyncStorage}
      options={{
        wagmi: {
          config: wagmiConfig,
          queryClient: queryClient,
        },
      }}
    >
      <YourApp />
    </FormoAnalyticsProvider>
  );
}
```

This automatically tracks:
- Wallet connections and disconnections
- Chain changes
- Signature requests (with QueryClient)
- Transaction events (with QueryClient)

## API Reference

### FormoAnalyticsProvider Props

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| `writeKey` | `string` | Yes | Your Formo write key |
| `asyncStorage` | `AsyncStorageInterface` | Yes | AsyncStorage instance |
| `options` | `Options` | No | Configuration options |
| `disabled` | `boolean` | No | Disable analytics |

### Options

```typescript
interface Options {
  // Wagmi integration
  wagmi?: {
    config: any;      // Wagmi config from createConfig()
    queryClient?: any; // TanStack QueryClient for mutation tracking
  };

  // App information
  app?: {
    name?: string;
    version?: string;
    build?: string;
    bundleId?: string;
  };

  // Event batching
  flushAt?: number;       // Batch size (default: 20)
  flushInterval?: number; // Flush interval in ms (default: 30000)
  retryCount?: number;    // Retry count (default: 3)
  maxQueueSize?: number;  // Max queue size in bytes (default: 500KB)

  // Autocapture control
  autocapture?: boolean | {
    connect?: boolean;
    disconnect?: boolean;
    signature?: boolean;
    transaction?: boolean;
    chain?: boolean;
  };

  // Tracking control
  tracking?: boolean | {
    excludeChains?: number[];
  };

  // Logging
  logger?: {
    enabled?: boolean;
    levels?: ('debug' | 'info' | 'warn' | 'error' | 'log')[];
  };

  // Custom API host
  apiHost?: string;

  // Ready callback
  ready?: (formo: IFormoAnalytics) => void;
}
```

### useFormo Hook Methods

#### `screen(name, properties?, context?, callback?)`
Track a screen view.

```typescript
formo.screen('Profile', { userId: '123' });
```

#### `track(event, properties?, context?, callback?)`
Track a custom event.

```typescript
formo.track('Purchase Completed', {
  revenue: 99.99,
  currency: 'USD',
  productId: 'nft-001',
});
```

#### `identify(params, properties?, context?, callback?)`
Identify a user by their wallet address.

```typescript
formo.identify({
  address: '0x1234...',
  userId: 'user-123',
  providerName: 'MetaMask',
  rdns: 'io.metamask',
});
```

#### `connect(params, properties?, context?, callback?)`
Track wallet connection.

```typescript
formo.connect({
  chainId: 1,
  address: '0x1234...',
});
```

#### `disconnect(params?, properties?, context?, callback?)`
Track wallet disconnection.

```typescript
formo.disconnect({
  chainId: 1,
  address: '0x1234...',
});
```

#### `chain(params, properties?, context?, callback?)`
Track chain change.

```typescript
formo.chain({
  chainId: 137,
  address: '0x1234...',
});
```

#### `signature(params, properties?, context?, callback?)`
Track signature event.

```typescript
import { SignatureStatus } from '@formo/react-native-analytics';

formo.signature({
  status: SignatureStatus.CONFIRMED,
  chainId: 1,
  address: '0x1234...',
  message: 'Sign this message',
  signatureHash: '0xabcd...',
});
```

#### `transaction(params, properties?, context?, callback?)`
Track transaction event.

```typescript
import { TransactionStatus } from '@formo/react-native-analytics';

formo.transaction({
  status: TransactionStatus.BROADCASTED,
  chainId: 1,
  address: '0x1234...',
  to: '0x5678...',
  value: '1000000000000000000',
  transactionHash: '0xdef...',
});
```

#### Consent Management

```typescript
// Opt out of tracking (GDPR compliance)
formo.optOutTracking();

// Check opt-out status
const isOptedOut = formo.hasOptedOutTracking();

// Opt back in
formo.optInTracking();
```

## Event Types

The SDK automatically enriches events with mobile-specific context:

- Device information (OS, version, model)
- Screen dimensions and density
- Locale and timezone
- App information (if provided)
- Anonymous ID (persistent across sessions)

## Offline Support

Events are queued locally and sent when the device has network connectivity. Events are automatically flushed when:

- The batch size is reached (default: 20 events)
- The flush interval passes (default: 30 seconds)
- The app goes to background

## License

MIT
