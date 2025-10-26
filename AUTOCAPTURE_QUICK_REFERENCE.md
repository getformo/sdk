# Autocapture - Quick Reference

## 🚀 Quick Start

### Default (All Events Enabled)
```typescript
FormoAnalytics.init('YOUR_WRITE_KEY');
```

### Disable All Wallet Events
```typescript
FormoAnalytics.init('YOUR_WRITE_KEY', {
  autocapture: false
});
```

### Granular Control
```typescript
FormoAnalytics.init('YOUR_WRITE_KEY', {
  autocapture: {
    enabled: true,
    events: {
      connect: true,      // ✅ Track
      disconnect: true,   // ✅ Track
      signature: false,   // ❌ Don't track
      transaction: false, // ❌ Don't track
      chain: true         // ✅ Track
    }
  }
});
```

## 📋 Event Types

| Event | Description | Listener Type |
|-------|-------------|---------------|
| `connect` | Wallet connection | accountsChanged, connect |
| `disconnect` | Wallet disconnection | accountsChanged, disconnect |
| `signature` | Message signing | provider.request wrapper |
| `transaction` | Transaction sending | provider.request wrapper |
| `chain` | Network switch | chainChanged |

## 🎯 Common Patterns

### DeFi App
```typescript
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
```

### NFT Marketplace
```typescript
autocapture: {
  enabled: true,
  events: {
    connect: true,
    disconnect: true,
    signature: true,
    transaction: true,
    chain: false
  }
}
```

### Connection Tracking Only
```typescript
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
```

### Reduce Noise (No Signatures)
```typescript
autocapture: {
  enabled: true,
  events: {
    signature: false
    // All others default to true
  }
}
```

## ⚛️ React/Next.js

### React
```tsx
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
  <App />
</FormoAnalyticsProvider>
```

### Next.js App Router
```tsx
// app/layout.tsx
<FormoAnalyticsProvider
  writeKey={process.env.NEXT_PUBLIC_FORMO_WRITE_KEY}
  options={{
    autocapture: { /* config */ }
  }}
>
  {children}
</FormoAnalyticsProvider>
```

## 🌐 Browser CDN

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

## 🔧 Manual Tracking Override

Even with autocapture disabled, manual tracking works:

```typescript
const analytics = await FormoAnalytics.init('YOUR_WRITE_KEY', {
  autocapture: false
});

// Manually track events
await analytics.connect({ chainId: 1, address: '0x...' });
await analytics.transaction({ status: 'broadcasted', chainId: 1, address: '0x...', transactionHash: '0x...' });
await analytics.signature({ status: 'confirmed', chainId: 1, address: '0x...', message: '...' });
```

## 📊 Performance Impact

| Configuration | Listeners Saved | Request Wrapper | Performance Gain |
|---------------|-----------------|-----------------|------------------|
| All disabled | 5 per provider | Not installed | ⚡⚡⚡ High |
| Signature disabled | 0 | Partially disabled | ⚡ Low |
| Transaction disabled | 0 | Partially disabled | ⚡ Low |
| Sig + Tx disabled | 0 | Not installed | ⚡⚡ Medium |

## ✅ Default Behavior

| Scenario | Result |
|----------|--------|
| No config | All events enabled ✅ |
| `autocapture: true` | All events enabled ✅ |
| `autocapture: false` | All events disabled ❌ |
| `enabled: true, events: {}` | All events enabled ✅ |
| `enabled: false, events: {...}` | All events disabled ❌ |
| Unspecified event | Enabled ✅ (default) |

## 🔒 Important Notes

- ✅ **Backward Compatible**: Default behavior unchanged
- ✅ **Zero Dependencies**: No new packages added
- ✅ **Type Safe**: Full TypeScript support
- ✅ **Performance**: No listeners = no overhead
- ⚠️ **Runtime**: Cannot change config after init
- ⚠️ **Manual Tracking**: Always available regardless of autocapture

## 📚 More Resources

- **Comprehensive Guide**: `AUTOCAPTURE.md`
- **Implementation Details**: `CHANGELOG_AUTOCAPTURE.md`
- **Code Examples**: `examples/wallet-autocapture-examples.ts`
- **Tests**: `test/FormoAnalytics.autocapture.spec.ts`
- **Documentation**: https://docs.formo.so

## 🆘 Need Help?

- **Slack**: https://formo.so/slack
- **GitHub**: https://github.com/getformo/sdk/issues
- **Docs**: https://docs.formo.so

