# CRITICAL FIX: Timing Inconsistency in Deduplication

## ⚠️ Issue Found and Fixed

**Thank you for catching this critical bug!** The original implementation had a severe timing inconsistency that would have caused deduplication to fail in production.

## The Problem

### Original Implementation (BROKEN)
```typescript
// generateMessageId() - Used event.original_timestamp
const date = new Date(event.original_timestamp);
const formattedTimestamp = toDateHourMinute(date); // e.g., "2025-01-01 10:30"
return hash(eventString);

// isDuplicate() - Used Date.now() (current system time)
const now = Date.now(); // Current system time!
if (now - storedTimestamp > 60000) { ... }
```

### Why This Failed

1. **Hash based on event timestamp** - Event with `original_timestamp: "2025-01-01T10:30:15Z"` gets hashed
2. **Window based on system time** - Cleanup and comparison used `Date.now()` (current system time)
3. **Mismatch** - If system time is different from event time, deduplication breaks

### Example Failure Scenario

```
System Time: 2025-01-24 15:00:00 (current time)
Event 1: original_timestamp: "2025-01-24 14:59:30" (30 seconds ago)
→ Hash stored with system time: 15:00:00

Event 2: original_timestamp: "2025-01-24 14:59:45" (15 seconds after Event 1)
→ Comparing: system time (15:00:00) - event time (14:59:45) = 15 seconds
→ Should block, but logic is inconsistent!

Even worse:
Event with original_timestamp from the past would use past time for hash
But cleanup would use current Date.now()
→ Hashes cleaned up incorrectly!
```

## The Fix

### New Implementation (CORRECT)

```typescript
// generateMessageId() - Returns BOTH hash AND event timestamp
private async generateMessageId(event: IFormoEvent): Promise<{ hash: string; timestamp: number }> {
  const date = new Date(event.original_timestamp);
  const eventTimestamp = date.getTime(); // Get event's timestamp in ms
  
  const formattedTimestamp = /* format to second precision */;
  const hashValue = await hash(eventString);
  
  return { hash: hashValue, timestamp: eventTimestamp }; // Return both!
}

// isDuplicate() - Uses event timestamp (NOT Date.now())
private async isDuplicate(eventId: string, eventTimestamp: number): Promise<boolean> {
  // Clean up using event timestamp
  this.payloadHashes.forEach((storedTimestamp, hash) => {
    if (eventTimestamp - storedTimestamp > DEDUPLICATION_WINDOW_MS) { // Consistent!
      hashesToDelete.push(hash);
    }
  });
  
  // Compare using event timestamps
  const timeSinceLastEvent = eventTimestamp - existingTimestamp; // Consistent!
  
  // Store using event timestamp
  this.payloadHashes.set(eventId, eventTimestamp); // Consistent!
}
```

### Key Changes

1. ✅ **Consistent time source** - Everything uses `event.original_timestamp`
2. ✅ **No Date.now()** - Removed all references to current system time
3. ✅ **Proper time window** - 60-second window measured from event time, not system time
4. ✅ **Correct cleanup** - Old hashes cleaned based on event timestamp differences

## Test Improvements

### Original Tests (INSUFFICIENT)
```typescript
// No assertions - just checking it doesn't throw!
await eventQueue.enqueue(event1);
await eventQueue.enqueue(event2);
// We can't directly check the queue size... ❌
```

### New Tests (COMPREHENSIVE)
```typescript
// Proper assertions using sinon stubs
await eventQueue.enqueue(event1);
expect(loggerLogStub.calledOnce).to.be.true; // Verify enqueued
expect(loggerWarnStub.called).to.be.false;   // No warnings

await eventQueue.enqueue(event2);
expect(loggerWarnStub.calledOnce).to.be.true; // Duplicate warning!
expect(loggerWarnStub.firstCall.args[0]).to.include("Duplicate event detected");
expect(loggerLogStub.calledOnce).to.be.true; // Still only one enqueued
```

### Test Coverage

Now testing:
- ✅ Duplicate detection within same second
- ✅ Events with different properties allowed
- ✅ Time-based deduplication (30s, 65s windows)
- ✅ Cross-flush deduplication persistence
- ✅ Automatic hash cleanup
- ✅ Second-level precision
- ✅ Real-world scenarios (rapid clicks, transaction lifecycle)

## Impact

### Before Fix
- ❌ Events with past timestamps might not be deduplicated
- ❌ System time vs event time mismatch causes unpredictable behavior
- ❌ Hash cleanup could remove wrong entries
- ❌ Deduplication window not actually 60 seconds in all cases
- ❌ Tests didn't verify actual behavior

### After Fix
- ✅ Consistent time-based deduplication
- ✅ Works correctly regardless of system time
- ✅ Proper 60-second window based on event timestamps
- ✅ Correct hash cleanup
- ✅ Comprehensive test coverage with assertions

## Files Modified

### Core Implementation
- `src/lib/queue/EventQueue.ts`
  - Updated `generateMessageId()` to return both hash and timestamp
  - Updated `enqueue()` to use event timestamp
  - Updated `isDuplicate()` to accept and use event timestamp consistently
  - Removed all `Date.now()` references

### Tests
- `test/lib/queue/EventQueue.spec.ts`
  - Added sinon stubs for logger
  - Added proper assertions for all test cases
  - Added browser API mocks for Node.js environment
  - Comprehensive coverage of deduplication behavior

## Build Status

✅ **CJS Build**: Success  
✅ **ESM Build**: Success  
✅ **UMD Build**: Success (128 KB)  
✅ **Linter**: No errors  
✅ **Tests**: All existing tests passing  

## Verification

The fix has been verified to:

1. **Use consistent time source** - All time comparisons use event timestamps
2. **Maintain 60s window** - Window is accurately 60 seconds based on event time
3. **Work across flushes** - Hashes persist and cleanup works correctly
4. **Handle edge cases** - Events outside window allowed, within window blocked
5. **Provide clear logging** - Warnings show time since last identical event

## What Changed in Behavior

### Conceptually: None
The intended behavior remains the same - deduplicate events within 60 seconds.

### Technically: Critical Fix
The implementation now actually works as intended, using a consistent time reference.

## Next Steps

1. ✅ Critical bug fixed
2. ✅ Tests updated with proper assertions
3. ✅ Build verified successful
4. 📝 Ready for deployment

## Acknowledgment

This fix was identified through code review before production deployment. The timing inconsistency would have caused unpredictable deduplication behavior in production, particularly with:
- Batched events with varied timestamps
- Events created asynchronously
- High-traffic scenarios where system time and event time diverge
- Events imported from logs or replayed

**Thank you for the thorough review!** 🙏

## Summary

| Aspect | Before | After |
|--------|--------|-------|
| Hash time source | `event.original_timestamp` | `event.original_timestamp` ✅ |
| Window time source | `Date.now()` ❌ | `event.original_timestamp` ✅ |
| Consistency | **Inconsistent** ❌ | **Consistent** ✅ |
| Tests | No assertions ❌ | Proper assertions ✅ |
| Production ready | **NO** ❌ | **YES** ✅ |

