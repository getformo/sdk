# Debugging Excess Custom Events

## Quick Diagnostic Steps

### 1. Enable SDK Logging
First, enable detailed logging to see what's happening:

```typescript
const analytics = await FormoAnalytics.init(writeKey, {
  logger: {
    enabled: true,
    levels: ['info', 'warn', 'error', 'debug'] // Add 'debug' for maximum detail
  }
});
```

### 2. Check Console for Deduplication Warnings
With the fix applied, you should see warnings like:
```
Duplicate event detected and blocked. Same event was sent 5s ago. Events are deduplicated within a 60s window.
```

If you see many of these warnings, your integration is trying to send duplicate events.

### 3. Common Causes of Excess Events

#### A. React State Updates
```typescript
// ❌ BAD - Will fire on every render
function TransactionComponent() {
  const [status, setStatus] = useState('pending');
  
  // This fires on every render!
  analytics.track('transaction_status', { status });
  
  return <div>Transaction: {status}</div>;
}

// ✅ GOOD - Only fires when status changes
function TransactionComponent() {
  const [status, setStatus] = useState('pending');
  
  useEffect(() => {
    analytics.track('transaction_status', { status });
  }, [status]); // Only when status changes
  
  return <div>Transaction: {status}</div>;
}
```

#### B. Event Handler Duplication
```typescript
// ❌ BAD - Multiple listeners on the same button
function TransactionButton() {
  const handleClick = () => {
    analytics.track('transaction_submit', { type: 'swap' });
  };
  
  // If this component re-renders, listeners accumulate!
  useEffect(() => {
    button.addEventListener('click', handleClick);
    // Missing cleanup!
  }, []);
  
  return <button>Submit</button>;
}

// ✅ GOOD - Proper cleanup
function TransactionButton() {
  const handleClick = () => {
    analytics.track('transaction_submit', { type: 'swap' });
  };
  
  return <button onClick={handleClick}>Submit</button>;
}
```

#### C. Transaction Lifecycle Events
```typescript
// ❌ BAD - Firing events on every wallet state update
wallet.on('transactionUpdate', (tx) => {
  // This fires multiple times for the same transaction!
  if (tx.status === 'success') {
    analytics.track('transaction_success', { 
      txHash: tx.hash,
      type: tx.type 
    });
  }
});

// ✅ GOOD - Track state transitions only
const seenTransactions = new Set();

wallet.on('transactionUpdate', (tx) => {
  const key = `${tx.hash}-${tx.status}`;
  if (!seenTransactions.has(key)) {
    seenTransactions.add(key);
    analytics.track('transaction_success', { 
      txHash: tx.hash,
      type: tx.type 
    });
  }
});
```

#### D. Retries and Error Handling
```typescript
// ❌ BAD - Tracking on every retry
async function submitTransaction() {
  for (let i = 0; i < 3; i++) {
    try {
      analytics.track('transaction_submit', { type: 'swap' }); // Fires 3 times!
      await wallet.sendTransaction(...);
      break;
    } catch (e) {
      if (i === 2) throw e;
    }
  }
}

// ✅ GOOD - Track once before retry loop
async function submitTransaction() {
  analytics.track('transaction_submit', { type: 'swap' }); // Once only
  
  for (let i = 0; i < 3; i++) {
    try {
      await wallet.sendTransaction(...);
      break;
    } catch (e) {
      if (i === 2) throw e;
    }
  }
}
```

### 4. Inspect Event Properties

Check if your events have enough unique properties to differentiate them:

```typescript
// ❌ BAD - Too generic, will be deduplicated
analytics.track('transaction_submit', { type: 'swap' });
analytics.track('transaction_submit', { type: 'swap' }); // Duplicate!

// ✅ GOOD - Include unique identifiers
analytics.track('transaction_submit', { 
  type: 'swap',
  txId: generateUniqueId(), // Unique per transaction
  timestamp: Date.now() // Unique per submission
});
```

### 5. Check Timing

Use timestamps to understand event timing:

```typescript
let lastEventTime = 0;

function trackWithTiming(eventName: string, properties: any) {
  const now = Date.now();
  const timeSinceLast = now - lastEventTime;
  
  console.log(`Tracking ${eventName} - ${timeSinceLast}ms since last event`);
  analytics.track(eventName, properties);
  
  lastEventTime = now;
}

// Usage
trackWithTiming('transaction_submit', { type: 'swap' });
// Console: "Tracking transaction_submit - 0ms since last event"

// If you see very short intervals (< 100ms), you likely have duplicate calls
```

## Advanced Debugging

### Monitor Queue State

Add this helper to see what's in the queue:

```typescript
// After SDK initialization
console.log('Provider state:', analytics.getProviderState());
// {
//   totalProviders: 2,
//   trackedProviders: 2,
//   seenProviders: 2,
//   activeProvider: true
// }
```

### Create a Wrapper

For development, wrap the track function to log all calls:

```typescript
const originalTrack = analytics.track.bind(analytics);
let callCount = 0;

analytics.track = function(eventName: string, properties?: any, ...args: any[]) {
  callCount++;
  console.log(`[${callCount}] Track called:`, {
    eventName,
    properties,
    stack: new Error().stack // See where it was called from
  });
  return originalTrack(eventName, properties, ...args);
};
```

### Check Call Stack

When you see duplicate warnings, check the call stack to find the source:

```typescript
// In your event tracking code
console.trace('Event tracked from:');
analytics.track('transaction_submit', { type: 'swap' });
```

## Expected Behavior vs. Bugs

### ✅ Expected: Multiple Different Events
```typescript
// These are different events and should all be sent:
analytics.track('transaction_submit', { type: 'swap' });
analytics.track('transaction_success', { type: 'swap' }); // Different event name
analytics.track('transaction_submit', { type: 'trade' }); // Different properties
```

### ❌ Bug: Duplicate Same Events
```typescript
// These are duplicates and will be blocked (after the fix):
analytics.track('transaction_submit', { type: 'swap' });
analytics.track('transaction_submit', { type: 'swap' }); // Within 60s - BLOCKED!
```

## Verifying the Fix

After deploying the fix:

1. **Check Warning Logs**: You should see warnings for duplicate attempts
2. **Compare Event Counts**: Your analytics dashboard should show reduced event volume
3. **Verify Event Ratios**: Check if submit/success/error ratios make sense

Example ratios that make sense:
- ✅ 1000 submits, 950 successes, 50 errors = Normal
- ❌ 1000 submits, 5000 successes, 2000 errors = Something wrong

## Still Seeing Issues?

If you're still seeing excess events after this fix:

1. **The events might be genuinely different**: Check event properties carefully
2. **Events might be > 60s apart**: The deduplication window is 60s by default
3. **Events might be fired from different parts of your app**: Check all places where you call `track()`
4. **Browser/wallet issues**: Some wallets fire events multiple times

### Increase Deduplication Window (if needed)

If you need a longer window, modify the SDK:

```typescript
// In EventQueue.ts
const DEDUPLICATION_WINDOW_MS = 1_000 * 120; // 2 minutes instead of 1
```

## Contact Support

If issues persist, provide:
1. SDK logs with debug level enabled
2. Example event properties
3. Approximate event volume
4. Browser and wallet being used
5. Timeline of when events are fired

