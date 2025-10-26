# Autocapture Configuration

The Formo SDK provides granular control over which wallet events are automatically tracked. This allows you to optimize performance and only track the events that matter to your application.

## Overview

By default, the Formo SDK automatically captures all wallet events:
- **Connect**: When a user connects their wallet
- **Disconnect**: When a user disconnects their wallet
- **Signature**: When a user signs a message (personal_sign, eth_signTypedData_v4)
- **Transaction**: When a user sends a transaction (eth_sendTransaction)
- **Chain**: When a user switches networks/chains

## Configuration Options

### 1. Disable All Autocapture

If you want to disable all automatic wallet event tracking:

```typescript
import { FormoAnalytics } from '@formo/analytics';

const analytics = await FormoAnalytics.init('YOUR_WRITE_KEY', {
  autocapture: false
});
```

**Result**: No wallet event listeners are registered. No connect, disconnect, signature, transaction, or chain events are tracked automatically.

### 2. Enable All Autocapture (Default)

To explicitly enable all autocapture (this is the default behavior):

```typescript
const analytics = await FormoAnalytics.init('YOUR_WRITE_KEY', {
  autocapture: true
});

// Or simply omit the option (default is enabled)
const analytics = await FormoAnalytics.init('YOUR_WRITE_KEY');
```

**Result**: All wallet events are tracked automatically.

### 3. Granular Event Control

You can selectively enable or disable specific wallet events:

```typescript
const analytics = await FormoAnalytics.init('YOUR_WRITE_KEY', {
  autocapture: {
    enabled: true,
    events: {
      connect: true,      // Track wallet connections
      disconnect: true,   // Track wallet disconnections
      signature: false,   // Don't track signatures
      transaction: false, // Don't track transactions
      chain: true         // Track chain changes
    }
  }
});
```

**Result**: Only connect, disconnect, and chain events are tracked. Signature and transaction events are not tracked, and their respective listeners are not registered.

## Common Use Cases

### Use Case 1: Track Only Wallet Connections

Perfect for applications that only need to know when users connect/disconnect their wallets:

```typescript
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
```

### Use Case 2: Track Only Transactions

Ideal for DeFi applications that want to focus on transaction analytics:

```typescript
const analytics = await FormoAnalytics.init('YOUR_WRITE_KEY', {
  autocapture: {
    enabled: true,
    events: {
      connect: false,
      disconnect: false,
      signature: false,
      transaction: true,
      chain: false
    }
  }
});
```

### Use Case 3: Disable Only Signatures

For applications that handle many signature requests but don't need to track them all:

```typescript
const analytics = await FormoAnalytics.init('YOUR_WRITE_KEY', {
  autocapture: {
    enabled: true,
    events: {
      connect: true,
      disconnect: true,
      signature: false,  // Disable signature tracking
      transaction: true,
      chain: true
    }
  }
});
```

### Use Case 4: Manual Event Tracking Only

If you want complete control and prefer to manually track wallet events:

```typescript
const analytics = await FormoAnalytics.init('YOUR_WRITE_KEY', {
  autocapture: false  // Disable all autocapture
});

// Manually track events when needed
await analytics.connect({ chainId: 1, address: '0x...' });
await analytics.transaction({ 
  status: 'broadcasted', 
  chainId: 1, 
  address: '0x...', 
  transactionHash: '0x...' 
});
```

## React & Next.js Examples

### React Example

```typescript
import { FormoAnalyticsProvider } from '@formo/analytics';

function App() {
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
        }
      }}
    >
      <YourApp />
    </FormoAnalyticsProvider>
  );
}
```

### Next.js App Router Example

```typescript
// app/layout.tsx
import { FormoAnalyticsProvider } from '@formo/analytics';

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <FormoAnalyticsProvider
          writeKey={process.env.NEXT_PUBLIC_FORMO_WRITE_KEY}
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
```

### Next.js Pages Router Example

```typescript
// pages/_app.tsx
import { FormoAnalyticsProvider } from '@formo/analytics';

function MyApp({ Component, pageProps }) {
  return (
    <FormoAnalyticsProvider
      writeKey={process.env.NEXT_PUBLIC_FORMO_WRITE_KEY}
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
      <Component {...pageProps} />
    </FormoAnalyticsProvider>
  );
}
```

## Browser CDN Example

```html
<script
  src="https://cdn.formo.so/analytics@latest"
  defer
  onload="
    window.formofy('YOUR_WRITE_KEY', {
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
    });
  "
></script>
```

## Performance Considerations

When you disable specific wallet events, the SDK does not register the corresponding event listeners at all. This means:

1. **Reduced Memory Usage**: Fewer event listeners registered on wallet providers
2. **Lower CPU Usage**: No processing of disabled event types
3. **Smaller Bundle Impact**: Conditional logic prevents unnecessary code execution

For example, if you disable signature and transaction tracking:
- The `provider.request` method is NOT wrapped
- No signature request/confirmation/rejection tracking occurs
- No transaction start/broadcast/confirmation tracking occurs
- The provider operates exactly as it would without Formo installed

## TypeScript Support

All configuration options are fully typed:

```typescript
import { FormoAnalytics, AutocaptureOptions } from '@formo/analytics';

const config: AutocaptureOptions = {
  enabled: true,
  events: {
    connect: true,
    disconnect: true,
    signature: false,
    transaction: false,
    chain: true
  }
};

const analytics = await FormoAnalytics.init('YOUR_WRITE_KEY', {
  autocapture: config
});
```

## Default Behavior

If you don't specify `autocapture` in your options:
- All wallet events are tracked (default: `enabled: true`)
- All event types are enabled (default: all events are `true`)

This ensures backward compatibility with existing integrations.

## FAQ

**Q: Can I change the autocapture settings after initialization?**  
A: No, autocapture settings are configured during SDK initialization and cannot be changed at runtime. To change settings, you would need to re-initialize the SDK.

**Q: If I disable all autocapture, can I still manually track events?**  
A: Yes! You can always manually call methods like `analytics.connect()`, `analytics.signature()`, etc., regardless of the autocapture settings.

**Q: Do these settings affect the `identify()` and `detect()` methods?**  
A: No, `identify()` and `detect()` are not affected by autocapture settings. These methods continue to work normally.

**Q: What happens if I set `enabled: false` but configure specific events?**  
A: If `enabled: false`, all autocapture is disabled regardless of individual event settings. The `enabled` flag takes precedence.

**Q: Can I track custom events while disabling autocapture?**  
A: Absolutely! Custom events tracked via `analytics.track()` are not affected by autocapture settings and will continue to work normally.

## Support

For questions or issues with autocapture configuration:
- Join the [Formo Slack community](https://formo.so/slack)
- Visit the [Documentation](https://docs.formo.so)
- Open an issue on [GitHub](https://github.com/getformo/sdk)

