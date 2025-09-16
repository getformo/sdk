# Drop-in Replacement Example

This example demonstrates the **easiest way** to add Formo Analytics to an existing Wagmi application - using drop-in replacement hooks that require **minimal code changes**.

## 🎯 Perfect for Existing Wagmi Apps

If you already have a Wagmi app and want to add analytics, this is the approach for you!

### Migration Steps

1. **Replace the provider** (1 line change):
   ```tsx
   // Before
   <FormoAnalyticsProvider writeKey="key">
   
   // After  
   <FormoAnalyticsProviderWithWagmi writeKey="key">
   ```

2. **Change hook imports** (just the import statements):
   ```tsx
   // Before
   import { useSignMessage, useSendTransaction } from 'wagmi';
   
   // After
   import { useSignMessage, useSendTransaction } from '@formo/analytics/wagmi';
   ```

3. **That's it!** Everything else stays exactly the same.

## Key Benefits

### ✅ **Zero API Changes**
- Hooks have identical signatures to original Wagmi hooks
- Same TypeScript types and behavior
- No refactoring of existing code needed

### ✅ **Minimal Migration Effort**
- Only import statements need to change
- Existing component logic stays unchanged
- Gradual migration possible (hook by hook)

### ✅ **Automatic Event Tracking**
- All signature events tracked automatically
- All transaction events tracked automatically
- Connection events tracked by provider

### ✅ **Full Compatibility**
- Works with all Wagmi features
- Compatible with existing error handling
- Maintains all original hook functionality

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure your Formo write key:**
   
   Edit `App.tsx` and replace `"your-formo-write-key"`:
   ```tsx
   <FormoAnalyticsProviderWithWagmi writeKey="your-actual-write-key">
   ```

3. **Configure WalletConnect (optional):**
   
   Replace `"your-project-id"` with your WalletConnect project ID.

4. **Start the development server:**
   ```bash
   npm run dev
   ```

## Code Comparison

### Before (Original Wagmi)
```tsx
import { 
  useSignMessage, 
  useSendTransaction,
  useAccount,
  useConnect 
} from 'wagmi';
import { FormoAnalyticsProvider } from '@formo/analytics';

function App() {
  return (
    <WagmiProvider config={config}>
      <FormoAnalyticsProvider writeKey="key">
        <WalletComponent />
      </FormoAnalyticsProvider>
    </WagmiProvider>
  );
}

function WalletComponent() {
  const { signMessage } = useSignMessage();
  const { sendTransaction } = useSendTransaction();
  
  // Your existing component logic...
}
```

### After (With Formo Tracking)
```tsx
import { 
  useAccount,
  useConnect 
} from 'wagmi';
// 🎯 Only these imports change!
import { 
  useSignMessage, 
  useSendTransaction 
} from '@formo/analytics/wagmi';
import { FormoAnalyticsProviderWithWagmi } from '@formo/analytics';

function App() {
  return (
    <WagmiProvider config={config}>
      {/* 🎯 Only this provider changes! */}
      <FormoAnalyticsProviderWithWagmi writeKey="key">
        <WalletComponent />
      </FormoAnalyticsProviderWithWagmi>
    </WagmiProvider>
  );
}

function WalletComponent() {
  const { signMessage } = useSignMessage(); // Same API, now with tracking!
  const { sendTransaction } = useSendTransaction(); // Same API, now with tracking!
  
  // Your existing component logic stays exactly the same!
}
```

## What Gets Tracked

| Event Type | Source | How |
|------------|--------|-----|
| **connect** | Provider | Automatic when wallet connects |
| **disconnect** | Provider | Automatic when wallet disconnects |
| **chain** | Provider | Automatic when network changes |
| **identify** | Provider | Automatic wallet identification |
| **signature** | Drop-in Hook | When using `useSignMessage` from Formo |
| **transaction** | Drop-in Hook | When using `useSendTransaction` from Formo |

## Hook Compatibility

### ✅ Supported Drop-in Replacements
- `useSignMessage` - Full compatibility with automatic event tracking
- `useSendTransaction` - Full compatibility with automatic event tracking

### ✅ Use Original Wagmi Hooks (Auto-tracked by Provider)
- `useAccount` - Connection events tracked automatically
- `useConnect` - Connection events tracked automatically  
- `useDisconnect` - Disconnection events tracked automatically
- `useChainId` - Chain change events tracked automatically
- `useSwitchChain` - Chain change events tracked automatically
- All other Wagmi hooks work normally

## Migration Strategy

### Option 1: All at Once
Replace all imports in one go for immediate full tracking.

### Option 2: Gradual Migration
Migrate hooks one component at a time:

```tsx
// Week 1: Add provider
<FormoAnalyticsProviderWithWagmi writeKey="key">

// Week 2: Migrate signature hooks
import { useSignMessage } from '@formo/analytics/wagmi';

// Week 3: Migrate transaction hooks  
import { useSendTransaction } from '@formo/analytics/wagmi';
```

## Advanced Usage

### Custom Event Properties
```tsx
const { signMessage } = useSignMessage({
  mutation: {
    onSuccess: (data, variables) => {
      // Your existing success handler
      console.log('Signature successful:', data);
    },
    onError: (error) => {
      // Your existing error handler  
      console.error('Signature failed:', error);
    }
  }
});
```

The drop-in hooks preserve all your existing mutation handlers while adding automatic tracking.

### Conditional Tracking
```tsx
<FormoAnalyticsProviderWithWagmi 
  writeKey="key"
  enableWagmiIntegration={process.env.NODE_ENV === 'production'}
>
  <App />
</FormoAnalyticsProviderWithWagmi>
```

## Troubleshooting

### "Hook not found" errors
Make sure you're importing the hook from the correct package:
```tsx
// ❌ Wrong
import { useSignMessage } from 'wagmi';

// ✅ Correct  
import { useSignMessage } from '@formo/analytics/wagmi';
```

### TypeScript issues
The drop-in hooks have identical TypeScript types. If you see type errors, ensure you have the latest version of both packages.

### Events not tracking
1. Check that you're using `FormoAnalyticsProviderWithWagmi`
2. Verify your write key is correct
3. Check browser console for Formo logs

## Comparison with Other Examples

| Example | Best For | Setup Complexity | Migration Effort |
|---------|----------|------------------|------------------|
| **Drop-in** | Existing Wagmi apps | Minimal | Very Low |
| [Enhanced](../wagmi-enhanced) | New apps | Low | N/A |
| [Basic](../wagmi-basic) | Learning/Custom control | Medium | Medium |

## Next Steps

- Try other examples to see different integration approaches
- Read the [full Wagmi integration documentation](../../docs/WAGMI_INTEGRATION.md)
- Explore advanced Formo Analytics features
