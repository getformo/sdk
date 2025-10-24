# Chain Switching and excludeChains Reliability Improvements

## Problem Statement

The original implementation had issues with dynamically switching chains when using the `excludeChains` configuration:

1. **Timing Issue**: `currentChainId` was updated BEFORE the tracking check, causing the check to evaluate against the NEW chain rather than considering the transition
2. **Asymmetric Behavior**: Switching TO an excluded chain wouldn't track the transition, but switching FROM an excluded chain would
3. **Lost Analytics**: Chain transitions are valuable analytics data that should be captured even when excluding activity on certain chains

## Solution Overview

The improvements focus on three key areas:

### 1. Context-Aware Tracking

The `shouldTrack()` method now accepts optional parameters to make context-aware decisions:

```typescript
private shouldTrack(eventType?: TEventType, chainId?: ChainID): boolean
```

- **eventType**: Allows different tracking behavior for different event types
- **chainId**: Allows checking a specific chain ID rather than just `currentChainId`

### 2. Chain Transition Tracking

Chain change events (`EventType.CHAIN`) are now **always tracked** when `excludeChains` is used:

```typescript
if (eventType === EventType.CHAIN) {
  // Always track chain change events - the transition itself is valuable
  logger.info(`Tracking chain transition involving excluded chain ${effectiveChainId}`);
  return true;
}
```

**Rationale**: Even if you don't want to track transactions/signatures on a specific chain (e.g., Monad), you still want to know:
- When users switch TO that chain
- When users switch FROM that chain
- How often users interact with that chain

### 3. Enhanced Event Context

The `trackEvent()` method now extracts the chainId from the event payload:

```typescript
const chainIdForCheck = payload?.chainId !== undefined ? payload.chainId : this.currentChainId;
```

This ensures that the tracking check uses the chain ID associated with the specific event, not just the global state.

### 4. Better Logging and Analytics

The `onChainChanged` handler now:
- Captures the previous chain ID before updating
- Includes `previousChainId` in event properties for better analytics
- Logs the transition for debugging

```typescript
const previousChainId = this.currentChainId;
// ... update logic ...
return this.chain({
  chainId: nextChainId,
  address: this.currentAddress,
}, {
  ...(previousChainId && { previousChainId })
});
```

## Behavior Changes

### Before

| Scenario | Old Behavior | Issue |
|----------|-------------|-------|
| Load on Chain A (excluded) | ❌ No tracking | ✓ Expected |
| Switch A → B (not excluded) | ✅ Tracked | ✓ OK |
| Switch B → A (excluded) | ❌ Not tracked | ❌ Lost transition data |
| Transactions on A | ❌ Not tracked | ✓ Expected |

### After

| Scenario | New Behavior | Benefit |
|----------|-------------|---------|
| Load on Chain A (excluded) | ❌ No tracking | ✓ Expected |
| Switch A → B (not excluded) | ✅ **Transition tracked** | ✓ Captures exit from A |
| Switch B → A (excluded) | ✅ **Transition tracked** | ✓ Captures entry to A |
| Transactions on A | ❌ Not tracked | ✓ Respects exclusion |
| Transactions on B | ✅ Tracked | ✓ Normal tracking |

## Configuration Example

```typescript
const analytics = await FormoAnalytics.init('your-write-key', {
  tracking: {
    excludeChains: [41455], // Monad chain ID
    excludeHosts: ['staging.example.com'],
    excludePaths: ['/admin']
  },
  logger: {
    enabled: true,
    levels: ['info', 'warn', 'error']
  }
});
```

With this configuration:
- ✅ Chain switch events are always tracked (you'll see when users switch to/from Monad)
- ❌ Transactions on Monad chain are NOT tracked
- ❌ Signatures on Monad chain are NOT tracked  
- ✅ All activity on other chains is tracked normally

## Technical Details

### Event Flow

1. User switches from Chain 1 to Chain 2 (excluded)
2. `onChainChanged()` is triggered
3. Previous chain ID (1) is captured
4. Current chain ID is updated to 2
5. `chain()` event is emitted with chainId=2
6. `trackEvent()` is called with the payload containing chainId=2
7. `shouldTrack(EventType.CHAIN, 2)` is called
8. Logic detects it's a CHAIN event and returns `true` (always track transitions)
9. Event is sent with properties including `previousChainId: 1`

### Edge Cases Handled

1. **Null/Undefined Chain IDs**: Falls back to `currentChainId`
2. **Chain ID = 0**: Used as fallback but can be excluded if explicitly in `excludeChains`
3. **Rapid Chain Switching**: Each transition is tracked independently
4. **Disconnected State**: Chain changes are ignored if no address is connected

## Migration Guide

This is a **non-breaking change**. Existing code will continue to work, but you'll get improved behavior:

- If you're NOT using `excludeChains`: No change in behavior
- If you ARE using `excludeChains`: You'll now see chain transition events in your analytics

### If You DON'T Want Chain Transitions Tracked

If you want to maintain the old behavior (not tracking any events involving excluded chains), you'll need to filter these on the backend based on the `previousChainId` property or implement custom filtering logic.

## Testing Recommendations

1. **Test Chain Switching**:
   ```typescript
   // Switch from Ethereum to Monad
   await window.ethereum.request({
     method: 'wallet_switchEthereumChain',
     params: [{ chainId: '0xa1ef' }], // Monad
   });
   // Verify chain event is tracked
   
   // Try a transaction on Monad
   // Verify transaction is NOT tracked
   
   // Switch back to Ethereum
   await window.ethereum.request({
     method: 'wallet_switchEthereumChain', 
     params: [{ chainId: '0x1' }],
   });
   // Verify chain event is tracked
   ```

2. **Check Logs**: Enable logger to see tracking decisions
   ```typescript
   logger.info(`Tracking chain transition involving excluded chain 41455`)
   logger.info(`Skipping transaction on excluded chain 41455`)
   ```

3. **Verify Analytics**: Check that your analytics dashboard shows:
   - Chain switch events with `previousChainId` property
   - No transaction/signature events on excluded chains
   - Normal events on non-excluded chains

## Performance Impact

- **Minimal**: Added parameter passing and one additional conditional check
- **No additional API calls**: Same number of events tracked
- **Better data quality**: More accurate chain transition tracking

## Future Enhancements

Possible future improvements:
1. Add `includeOnlyChains` option (whitelist instead of blacklist)
2. Add per-event-type exclusion rules (e.g., track signatures but not transactions)
3. Add chain-specific rate limiting
4. Add transition analytics (e.g., "chain dwell time")

