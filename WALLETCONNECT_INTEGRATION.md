# WalletConnect Integration for Formo Analytics SDK

This document describes the enhanced WalletConnect support added to the Formo Analytics SDK to better handle mobile wallet connections and ensure proper event emission.

## Overview

The Formo SDK now includes comprehensive WalletConnect support that addresses common issues with mobile wallet integration:

- **Enhanced Provider Detection**: Better identification of WalletConnect-based providers
- **Mobile Wallet Support**: Specific support for popular mobile wallets (Trust, Coinbase, Binance, etc.)
- **Improved Event Handling**: Proper connect/disconnect event emission for WalletConnect providers
- **Debug Utilities**: Tools to help troubleshoot connection issues

## Supported Mobile Wallets

The SDK now properly detects and handles these mobile wallets when connected via WalletConnect:

- **Trust Wallet** (`com.trustwallet`)
- **Coinbase Wallet** (`com.coinbase.wallet`)
- **Binance Wallet** (`com.binance.wallet`)
- **Rainbow** (`me.rainbow`)
- **ImToken** (`im.token`)
- **MathWallet** (`com.mathwallet`)
- **TokenPocket** (`com.tokenpocket`)
- **OKX Wallet** (`com.okx.wallet`)
- **BitKeep** (`com.bitkeep`)
- **MetaMask Mobile** (`io.metamask.mobile`)

## Key Improvements

### 1. Enhanced Provider Detection

The SDK now uses multiple detection methods to identify WalletConnect providers:

```typescript
// Multiple WalletConnect detection patterns
private isWalletConnectProvider(provider: EIP1193Provider): boolean {
  return !!(
    provider.isWalletConnect ||
    provider.connector ||
    provider.bridge ||
    provider.wc ||
    provider.walletConnectVersion ||
    // ... additional detection patterns
  );
}
```

### 2. WalletConnect-Specific Event Listeners

The SDK registers additional event listeners for WalletConnect providers:

- `session_update` - Handles session changes
- `connect` - WalletConnect connection events
- `disconnect` - WalletConnect disconnection events
- `session_request` - Session-related requests

### 3. Improved Connect Event Emission

The SDK now properly emits connect events for WalletConnect providers by:

- Monitoring WalletConnect session updates
- Handling mobile-specific connection patterns
- Ensuring proper provider switching between desktop and mobile wallets

## Usage

### Basic Integration

No changes are required to your existing Formo Analytics integration. The enhanced WalletConnect support works automatically:

```javascript
// Initialize Formo Analytics as usual
const analytics = await FormoAnalytics.init('your-write-key');

// WalletConnect providers will now be properly detected and tracked
```

### Debug Mode

Enable debug logging to monitor WalletConnect events:

```javascript
const analytics = await FormoAnalytics.init('your-write-key', {
  logger: {
    enabled: true,
    levels: ['info', 'warn', 'error', 'debug']
  }
});
```

### Manual Connection Check

For debugging purposes, you can manually trigger a WalletConnect connection check:

```javascript
// Check current provider state
const state = analytics.getProviderState();
console.log('WalletConnect providers:', state.walletConnectProviders);

// Manually check WalletConnect connections
await analytics.checkWalletConnectConnections();
```

## Debugging WalletConnect Issues

### 1. Use the Debug Utilities

Include the debug script in your application:

```html
<script src="examples/walletconnect-debug.js"></script>
```

Then use the debug functions in your browser console:

```javascript
// Check provider state
FormoWalletConnectDebug.checkProviderState();

// Test connection
await FormoWalletConnectDebug.testConnection();

// Monitor events
FormoWalletConnectDebug.monitorProviderEvents();

// Check WalletConnect connections
await FormoWalletConnectDebug.checkWalletConnectConnections();
```

### 2. Common Issues and Solutions

#### Issue: Connect events not firing for mobile wallets

**Solution**: The SDK now automatically detects WalletConnect providers and registers appropriate event listeners. Enable debug logging to monitor the detection process.

#### Issue: Provider not recognized as WalletConnect

**Solution**: The enhanced detection logic checks multiple provider properties. If a provider is still not detected, check the console logs for provider information and consider adding custom detection logic.

#### Issue: Multiple providers causing conflicts

**Solution**: The SDK now properly handles provider switching and deduplication. Use `getProviderState()` to monitor provider management.

### 3. Monitoring Events

Enable comprehensive event monitoring:

```javascript
// Enable debug logging
FormoWalletConnectDebug.enableDebugLogging();

// Monitor all provider events
FormoWalletConnectDebug.monitorProviderEvents();

// Check provider state periodically
setInterval(() => {
  const state = analytics.getProviderState();
  console.log('Provider state:', state);
}, 5000);
```

## Testing Mobile Wallets

### Test Procedure

1. **Desktop Testing**:
   - Open your dApp in a desktop browser
   - Connect via WalletConnect QR code
   - Verify connect events are emitted
   - Test signature and transaction flows

2. **Mobile Testing**:
   - Open your dApp in mobile browser
   - Use wallet's built-in browser or deep linking
   - Verify connection detection
   - Test all wallet interactions

3. **Provider Switching**:
   - Connect with one wallet
   - Switch to another wallet
   - Verify proper disconnect/connect event sequence

### Expected Behavior

When a mobile wallet connects via WalletConnect, you should see:

```javascript
// Console logs (with debug enabled)
"WalletConnect provider detected: Trust Wallet"
"OnAccountsChanged: Detected wallet connection, emitting connect event"
"Connect event emitted with provider: com.trustwallet"
```

## API Reference

### New Methods

#### `isWalletConnectProvider(provider: EIP1193Provider): boolean`
Checks if a provider is WalletConnect-based.

#### `detectWalletConnectProvider(provider: EIP1193Provider): { name: string; rdns: string }`
Detects specific WalletConnect provider information.

#### `checkWalletConnectConnections(): Promise<void>`
Manually checks and emits connect events for WalletConnect providers.

#### `getProviderState(): object`
Returns current provider state including WalletConnect provider count.

### Enhanced Properties

The `getProviderState()` method now includes:

```typescript
{
  totalProviders: number;
  trackedProviders: number;
  seenProviders: number;
  activeProvider: boolean;
  walletConnectProviders: number; // New
}
```

## Migration Guide

### From Previous Versions

No breaking changes - the enhanced WalletConnect support is backward compatible. However, you may want to:

1. **Enable Debug Logging**: To monitor the improved detection
2. **Update Error Handling**: Take advantage of better error reporting
3. **Use New Debug Methods**: For troubleshooting connection issues

### Best Practices

1. **Always Enable Logging in Development**:
   ```javascript
   const analytics = await FormoAnalytics.init('your-write-key', {
     logger: { enabled: true, levels: ['info', 'warn', 'error'] }
   });
   ```

2. **Monitor Provider State**:
   ```javascript
   // Periodically check provider state in development
   console.log(analytics.getProviderState());
   ```

3. **Handle Connection Errors Gracefully**:
   ```javascript
   try {
     await analytics.connect({ chainId, address });
   } catch (error) {
     console.error('Connection failed:', error);
     // Implement fallback logic
   }
   ```

## Troubleshooting

### Common Error Messages

- **"WalletConnect provider not detected"**: Check if the wallet properly implements WalletConnect
- **"Connect event not emitted"**: Enable debug logging and check event listeners
- **"Provider switching failed"**: Verify proper disconnect/connect sequence

### Support

For additional support with WalletConnect integration:

1. Enable debug logging and check console output
2. Use the provided debug utilities
3. Check the provider state and event monitoring
4. Review the enhanced detection logic in the source code

## Contributing

When adding support for new mobile wallets:

1. Add the wallet flag to `WalletProviderFlags` interface
2. Update `detectInjectedProviderInfo()` method
3. Add wallet name mapping in `detectWalletConnectProvider()`
4. Test with the actual wallet application
5. Update this documentation

---

This enhanced WalletConnect integration ensures that mobile wallet connections are properly detected and tracked by the Formo Analytics SDK, providing better analytics coverage for mobile users.
