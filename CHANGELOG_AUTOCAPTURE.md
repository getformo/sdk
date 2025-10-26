# Changelog - Autocapture Feature

## New Feature: Granular Wallet Event Control

### Overview

Added comprehensive control over wallet event autocapture, allowing developers to selectively enable or disable specific wallet events (connect, disconnect, signature, transaction, chain).

### What's New

#### 1. New Configuration Option: `autocapture`

Added a new top-level option in the SDK initialization:

```typescript
FormoAnalytics.init('YOUR_WRITE_KEY', {
  autocapture: boolean | AutocaptureOptions
});
```

#### 2. New Type: `AutocaptureOptions`

```typescript
interface AutocaptureOptions {
  enabled?: boolean;  // Master switch for all autocapture
  events?: {
    connect?: boolean;      // Track wallet connections
    disconnect?: boolean;   // Track wallet disconnections  
    signature?: boolean;    // Track signatures
    transaction?: boolean;  // Track transactions
    chain?: boolean;        // Track chain changes
  };
}
```

### Breaking Changes

**None.** This is a backward-compatible addition. Default behavior remains unchanged:
- All wallet events are tracked by default
- Existing integrations continue to work without any code changes

### API Changes

#### New Options

**Simple boolean control:**
```typescript
// Disable all autocapture
{ autocapture: false }

// Enable all autocapture (default)
{ autocapture: true }
```

**Granular event control:**
```typescript
{
  autocapture: {
    enabled: true,
    events: {
      connect: true,
      disconnect: true,
      signature: false,    // Disable signature tracking
      transaction: false,  // Disable transaction tracking
      chain: true
    }
  }
}
```

### Implementation Details

#### Listener Registration

When wallet events are disabled, the corresponding listeners are **not registered at all**:

- `connect: false` → No accountsChanged listener, no connect listener
- `disconnect: false` → No disconnect listener
- `chain: false` → No chainChanged listener
- `signature: false` → provider.request not wrapped for signatures
- `transaction: false` → provider.request not wrapped for transactions

This ensures optimal performance by avoiding unnecessary event processing.

#### Internal Changes

1. **New Methods:**
   - `isWalletAutocaptureEnabled()`: Checks if autocapture is globally enabled
   - `isWalletEventEnabled(eventType)`: Checks if a specific event type should be tracked

2. **Modified Methods:**
   - `trackProvider()`: Conditionally registers listeners based on configuration
   - `registerRequestListeners()`: Only wraps provider.request if signature or transaction tracking is enabled
   - `onAccountsChanged()`: Checks if connect/disconnect events are enabled before emitting
   - `onChainChanged()`: Checks if chain events are enabled before emitting
   - `onConnected()`: Checks if connect events are enabled before emitting

3. **Updated Types:**
   - `Options` interface now includes `autocapture?: boolean | AutocaptureOptions`
   - New `AutocaptureOptions` interface exported from types

### Usage Examples

#### Example 1: Disable All Autocapture

```typescript
const analytics = await FormoAnalytics.init('YOUR_WRITE_KEY', {
  autocapture: false
});
```

**Result:** No wallet event listeners registered. Manual tracking still available.

#### Example 2: Track Only Transactions

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

**Result:** Only transaction events are tracked automatically.

#### Example 3: Disable Only Signatures

```typescript
const analytics = await FormoAnalytics.init('YOUR_WRITE_KEY', {
  autocapture: {
    enabled: true,
    events: {
      signature: false
    }
  }
});
```

**Result:** All wallet events tracked except signatures (defaults to true for unspecified events).

### React/Next.js Usage

```typescript
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
```

### Performance Impact

#### Memory Benefits
- Reduced event listener count
- Lower memory footprint when events are disabled

#### CPU Benefits
- No event processing for disabled event types
- No request wrapping overhead when signature/transaction tracking is disabled

#### Example Savings

Disabling signature and transaction tracking:
- Saves ~2 event listeners per provider
- Eliminates provider.request wrapping overhead
- Reduces processing for every RPC call

### Migration Guide

No migration needed! This is a fully backward-compatible addition.

**Optional:** If you want to optimize performance, review your analytics needs and disable unused events:

1. Identify which wallet events you actually need
2. Add `autocapture` configuration to your initialization
3. Test thoroughly to ensure you're still capturing the events you need

### Testing

Added comprehensive test suite:
- Configuration parsing tests
- Use case examples
- TypeScript type safety verification
- Performance implication tests

See: `test/FormoAnalytics.autocapture.spec.ts`

### Documentation

- Updated README.md with autocapture overview
- Created AUTOCAPTURE.md with comprehensive usage guide
- Added inline JSDoc comments for all new types
- Included examples for all common use cases

### Files Changed

1. **Core Implementation:**
   - `src/FormoAnalytics.ts`: Added autocapture control logic
   - `src/types/base.ts`: Added `AutocaptureOptions` type

2. **Documentation:**
   - `README.md`: Added feature overview
   - `AUTOCAPTURE.md`: Comprehensive usage guide
   - `CHANGELOG_AUTOCAPTURE.md`: This file

3. **Tests:**
   - `test/FormoAnalytics.autocapture.spec.ts`: Test suite

4. **Exports:**
   - `src/index.ts`: Already exports all types (no changes needed)

### Browser Support

Same as SDK base requirements:
- Modern browsers with ES6 support
- Node.js 14+
- React 16.8+ (for hooks)

### Dependencies

No new dependencies added.

### Version

This feature will be included in the next minor version release (following semver):
- Current: `1.20.0`
- Next: `1.21.0` (suggested)

Reason: New feature, backward compatible, no breaking changes.

### Future Enhancements

Potential future additions:
1. Runtime configuration changes (currently requires re-initialization)
2. Event sampling/throttling options
3. Conditional tracking based on custom logic
4. Per-chain event configuration

### Support

For questions or issues:
- GitHub: https://github.com/getformo/sdk/issues
- Slack: https://formo.so/slack
- Docs: https://docs.formo.so

### Authors

Implemented by: Formo Team
Date: October 2025

