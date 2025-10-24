# Event Deduplication Fix

## Problem

The SDK had a deduplication issue that could allow duplicate custom events to be sent, particularly when events were fired rapidly across multiple flush cycles.

### Root Causes

1. **Timestamp Precision Too Coarse**: Events were deduplicated using minute-level precision (HH:mm), meaning events at 10:30:15 and 10:30:45 would have the same hash.

2. **Hash Set Cleared on Flush**: The `payloadHashes` Set was cleared every time the queue flushed (every 10-30 seconds by default), breaking deduplication across flush cycles.

3. **Short Deduplication Window**: Because the hash set was cleared on flush, the effective deduplication window was only as long as the time between flushes, not a consistent time window.

### Example Scenario

```
Timeline:
10:30:15 - User fires "transaction_submit" event → Queued
10:30:25 - Queue flushes (20 events reached) → Hash set cleared
10:30:45 - User fires identical "transaction_submit" event → Queued (not detected as duplicate!)
```

Even though both events happened in the same minute, the second one was not caught because:
- The hash set was cleared at 10:30:25
- The timestamp rounding made both events have the same minute precision

## Solution

### Changes Made

1. **Improved Timestamp Precision** (`EventQueue.ts`, `generateMessageId()`)
   - Changed from minute precision (HH:mm) to second precision (HH:mm:ss)
   - Provides better granularity for deduplication
   - Events within the same second are still deduplicated

2. **Time-Based Hash Cleanup** (`EventQueue.ts`, `isDuplicate()`)
   - Changed `payloadHashes` from `Set<string>` to `Map<string, number>`
   - Each hash is now stored with its timestamp
   - Old hashes are cleaned up based on age, not on flush
   - Introduced `DEDUPLICATION_WINDOW_MS` constant (60 seconds)

3. **Persistent Deduplication Across Flushes** (`EventQueue.ts`, `flush()`)
   - Removed `payloadHashes.clear()` from flush method
   - Hashes now persist across flush cycles
   - Cleanup happens automatically based on time window

### New Behavior

```
Timeline:
10:30:15 - User fires "transaction_submit" event → Queued (hash stored with timestamp)
10:30:25 - Queue flushes (20 events reached) → Hash set NOT cleared
10:30:45 - User fires identical "transaction_submit" event → BLOCKED as duplicate!
           "Duplicate event detected and blocked. Same event was sent 30s ago. 
            Events are deduplicated within a 60s window."
```

### Configuration

The deduplication window is set to 60 seconds by default:

```typescript
const DEDUPLICATION_WINDOW_MS = 1_000 * 60; // 60 seconds
```

This can be adjusted in the code if needed for different use cases.

## Testing Recommendations

To verify the fix works correctly, test these scenarios:

1. **Rapid Duplicate Events**: Fire the same custom event multiple times within 1 second
   - Expected: Only the first one should be sent

2. **Cross-Flush Duplicates**: Fire identical events 40 seconds apart (spanning a flush)
   - Expected: Second event should be blocked as duplicate

3. **Time Window Expiration**: Fire identical events 65 seconds apart
   - Expected: Both events should be sent (outside deduplication window)

4. **Different Event Properties**: Fire similar events with different properties
   - Expected: Both should be sent (different hashes)

## Impact on Users

### Positive
- Prevents accidental duplicate events from being sent
- Reduces data noise and improves analytics accuracy
- Better protection against rapid-fire event bugs

### Considerations
- Events that are intentionally sent multiple times within 60 seconds will be deduplicated
- If your use case requires identical events within 60 seconds, you may need to:
  - Add distinguishing properties to make events unique
  - Adjust the deduplication window in the code

## Migration Notes

This is a **non-breaking change**. No API changes were made. The fix improves the existing deduplication behavior without requiring any changes to how developers use the SDK.

## For the Reported Issue

For the specific case mentioned:
- 9000 "transaction_submit" events
- Many more "transaction_success" and "transaction_error" events

This fix will help if:
1. The same event is being fired multiple times accidentally
2. Events are being triggered on multiple state updates for the same transaction
3. Race conditions are causing duplicate event calls

However, if the integration is genuinely calling the SDK that many times, the root cause should be addressed in the integration code. The SDK will now provide better warning messages when duplicates are detected, making it easier to identify where the duplicate calls are coming from.

## Debug Tips

Enable SDK logging to see deduplication warnings:

```typescript
const analytics = await FormoAnalytics.init(writeKey, {
  logger: {
    enabled: true,
    levels: ['warn', 'error', 'info']
  }
});
```

When duplicates are detected, you'll see:
```
Duplicate event detected and blocked. Same event was sent Xs ago. Events are deduplicated within a 60s window.
```

