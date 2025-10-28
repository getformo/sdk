# Unified Formo + Wagmi Integration Example

This example demonstrates the unified integration using `WagmiFormoProvider` - a single provider that combines Formo Analytics with automatic Wagmi detection and integration.

## Key Improvements

### ✅ **Single Provider Solution**
Simple, unified provider approach:
```tsx
// Unified approach
<WagmiProvider>
  <WagmiFormoProvider>
    <App />
  </WagmiFormoProvider>
</WagmiProvider>
```

### ✅ **Flexible Provider Layout**
The enhanced provider works regardless of layout order:

```tsx
// Layout 1: Wagmi outside (recommended)
<WagmiProvider>
  <WagmiFormoProvider>
    <App />
  </WagmiFormoProvider>
</WagmiProvider>

// Layout 2: Wagmi inside (also works)
<WagmiFormoProvider>
  <WagmiProvider>
    <App />
  </WagmiProvider>
</WagmiFormoProvider>
```

### ✅ **Automatic Wagmi Detection**
The provider automatically detects if Wagmi context is available and enables integration without any additional configuration.

## Features Demonstrated

- 🎯 **Single Provider Setup** - Replaces both FormoAnalyticsProvider + WagmiFormoProvider
- 🔍 **Automatic Detection** - Detects Wagmi context and enables integration automatically
- 📐 **Flexible Layout** - Works with WagmiProvider outside or inside
- ⚙️ **Zero Additional Config** - No extra setup beyond the provider
- 🏷️ **Source Tagging** - Events are tagged with `source: "wagmi-auto"` for identification

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure your Formo write key:**
   
   Edit `App.tsx` and replace `"your-formo-write-key"` with your actual key:
   ```tsx
   <WagmiFormoProvider writeKey="your-actual-write-key">
   ```

3. **Configure WalletConnect (optional):**
   
   Replace `"your-project-id"` with your WalletConnect project ID:
   ```tsx
   walletConnect({ projectId: 'your-actual-project-id' })
   ```

4. **Start the development server:**
   ```bash
   npm run dev
   ```

## Provider Configuration

The enhanced provider accepts all the same options as `FormoAnalyticsProvider` plus additional Wagmi-specific options:

```tsx
<WagmiFormoProvider 
  writeKey="your-key"
  // Standard Formo options
  options={{
    logger: { enabled: true },
    flushAt: 20,
    // ... other Formo options
  }}
  // Enhanced Wagmi options
  enableWagmiIntegration={true}  // Enable/disable Wagmi integration
  wagmiDebounceMs={100}          // Debounce time for wallet state changes
>
  <App />
</WagmiFormoProvider>
```

## Event Source Identification

Events from the enhanced provider are tagged with different sources:

| Source | Description |
|--------|-------------|
| `wagmi-auto` | Automatic events from WagmiFormoProvider |
| `wagmi` | Events from enhanced hooks (useFormoSignMessage, etc.) |
| `wagmi-manual` | Events from manual tracking with useFormoWallet |

This helps you identify where events are coming from in your analytics.

## Comparison with Basic Example

| Feature | Basic Example | Enhanced Example |
|---------|---------------|------------------|
| **Providers Needed** | 3 (Wagmi + Formo + WagmiFormo) | 2 (Wagmi + Enhanced Formo) |
| **Setup Complexity** | Medium | Simple |
| **Layout Flexibility** | Limited | High |
| **Auto-Detection** | No | Yes |
| **Source Tagging** | `wagmi` | `wagmi-auto` + `wagmi` |

## Migration from Basic Example

If you're using the basic example, migration is simple:

### Before
```tsx
<WagmiProvider config={config}>
  <FormoAnalyticsProvider writeKey="key">
    <WagmiFormoProvider>
      <App />
    </WagmiFormoProvider>
  </FormoAnalyticsProvider>
</WagmiProvider>
```

### After
```tsx
<WagmiProvider config={config}>
  <WagmiFormoProvider writeKey="key">
    <App />
  </WagmiFormoProvider>
</WagmiProvider>
```

## Advanced Usage

### Conditional Wagmi Integration
```tsx
<WagmiFormoProvider 
  writeKey="key"
  enableWagmiIntegration={process.env.NODE_ENV === 'production'}
>
  <App />
</WagmiFormoProvider>
```

### Custom Debouncing
```tsx
<WagmiFormoProvider 
  writeKey="key"
  wagmiDebounceMs={200} // Slower debouncing for apps with frequent state changes
>
  <App />
</WagmiFormoProvider>
```

### Fallback for Non-Wagmi Apps
The enhanced provider gracefully falls back to regular Formo Analytics if Wagmi is not detected:

```tsx
// Works in both Wagmi and non-Wagmi apps
<WagmiFormoProvider writeKey="key">
  <App /> {/* Will work with or without Wagmi context */}
</WagmiFormoProvider>
```

## Benefits

1. **Simplified Setup** - One provider instead of multiple
2. **Better Developer Experience** - Less boilerplate, clearer intent
3. **Flexible Architecture** - Works with different provider layouts
4. **Automatic Integration** - No manual configuration needed
5. **Backwards Compatible** - Existing code continues to work

## Next Steps

- Try the [Basic Example](../wagmi-basic) to see the original approach
- Check out the [Wagmi Integration Documentation](../../docs/WAGMI_INTEGRATION.md)
- Explore advanced patterns in your own applications
