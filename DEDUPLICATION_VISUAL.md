# Event Deduplication - Visual Explanation

## Timeline Comparison

### ❌ BEFORE THE FIX

```
Time:         10:30:00    10:30:15    10:30:25    10:30:45    10:31:00
              │           │           │           │           │
Event Flow:   │           │           │           │           │
              │           │           │           │           │
Submit #1 ────┤           │           │           │           │
  [Queued]    │           │           │           │           │
              │           │           │           │           │
              │   Queue   │           │           │           │
              │   [1 ev]  │           │           │           │
              │           │           │           │           │
Submit #2 ────┼───────────┤           │           │           │
  [Queued]    │           │           │           │           │
              │           │           │           │           │
              │   Queue   │           │           │           │
              │   [2 ev]  │           │           │           │
              │           │           │           │           │
              │           │  FLUSH!   │           │           │
              │           │  Sent: 2  │           │           │
              │           │  CLEARED  │           │           │
              │           │  Hash Set │           │           │
              │           │           │           │           │
Submit #3 ────┼───────────┼───────────┼───────────┤           │
  [Queued]    │           │           │           │           │
  ⚠️ DUPLICATE│           │           │           │           │
  NOT DETECTED│           │           │           │           │
              │           │           │  Queue    │           │
              │           │           │  [1 ev]   │           │
              │           │           │           │           │
              │           │           │           │  FLUSH!   │
              │           │           │           │  Sent: 1  │
              │           │           │           │           │
Result:       🔴 3 identical events sent (Submit #1, #2, #3)
```

### ✅ AFTER THE FIX

```
Time:         10:30:00    10:30:15    10:30:25    10:30:45    10:31:05
              │           │           │           │           │
Event Flow:   │           │           │           │           │
              │           │           │           │           │
Submit #1 ────┤           │           │           │           │
  [Queued]    │           │           │           │           │
  Hash: abc   │           │           │           │           │
  Time: :00   │           │           │           │           │
              │   Queue   │           │           │           │
              │   [1 ev]  │           │           │           │
              │   Hashes  │           │           │           │
              │   abc:00  │           │           │           │
              │           │           │           │           │
Submit #2 ────┼───────────┤           │           │           │
  ❌ BLOCKED  │           │           │           │           │
  Same Hash!  │           │           │           │           │
  "Sent 15s   │           │           │           │           │
   ago"       │           │           │           │           │
              │   Queue   │           │           │           │
              │   [1 ev]  │           │           │           │
              │   Hashes  │           │           │           │
              │   abc:00  │           │           │           │
              │           │           │           │           │
              │           │  FLUSH!   │           │           │
              │           │  Sent: 1  │           │           │
              │           │  PRESERVED│           │           │
              │           │  Hash Set │           │           │
              │           │           │           │           │
Submit #3 ────┼───────────┼───────────┼───────────┤           │
  ❌ BLOCKED  │           │           │           │           │
  Same Hash!  │           │           │           │           │
  "Sent 45s   │           │           │           │           │
   ago"       │           │           │           │           │
              │   Queue   │           │           │           │
              │   [0 ev]  │           │           │           │
              │   Hashes  │           │           │           │
              │   abc:00  │           │           │           │
              │           │           │           │           │
Submit #4 ────┼───────────┼───────────┼───────────┼───────────┤
  [Queued]    │           │           │           │           │
  65s later   │           │           │           │           │
  ✅ ALLOWED  │           │           │           │           │
  Outside 60s │           │           │           │           │
              │   Queue   │           │           │           │
              │   [1 ev]  │           │           │           │
              │   Hashes  │           │           │           │
              │   abc:05  │           │           │           │
              │   (abc:00 │           │           │           │
              │    cleaned)           │           │           │
              │           │           │           │           │
Result:       🟢 2 events sent (Submit #1, #4) - 50% reduction!
```

## Hash Generation Comparison

### ❌ BEFORE (Minute Precision)

```
Event at 10:30:15.123:
{
  event: "transaction_submit",
  properties: { type: "swap" },
  timestamp: "2025-01-01 10:30"  ← Rounded to minute
  ...
}
↓
Hash: "abc123def456"

Event at 10:30:45.789:
{
  event: "transaction_submit",
  properties: { type: "swap" },
  timestamp: "2025-01-01 10:30"  ← Same minute!
  ...
}
↓
Hash: "abc123def456"  ← SAME HASH but sent anyway (hash set cleared)
```

### ✅ AFTER (Second Precision)

```
Event at 10:30:15.123:
{
  event: "transaction_submit",
  properties: { type: "swap" },
  timestamp: "2025-01-01 10:30:15"  ← Rounded to second
  ...
}
↓
Hash: "abc123def456"
Stored: { "abc123def456": timestamp_10:30:15 }

Event at 10:30:15.789:  (Same second)
{
  event: "transaction_submit",
  properties: { type: "swap" },
  timestamp: "2025-01-01 10:30:15"  ← Same second
  ...
}
↓
Hash: "abc123def456"  ← SAME HASH
Check: Hash exists + within 60s = BLOCKED! ✅

Event at 10:30:16.000:  (Different second)
{
  event: "transaction_submit",
  properties: { type: "swap" },
  timestamp: "2025-01-01 10:30:16"  ← Different second
  ...
}
↓
Hash: "xyz789abc123"  ← DIFFERENT HASH
Check: Hash doesn't exist = ALLOWED ✅
```

## Hash Cleanup Process

### Old Behavior (Cleared on Flush)
```
┌─────────────────────────────────────────┐
│  Hash Set                               │
├─────────────────────────────────────────┤
│  abc123: (event 1)                      │
│  def456: (event 2)                      │
│  ghi789: (event 3)                      │
└─────────────────────────────────────────┘
                  │
                  │ Flush triggered
                  ↓
┌─────────────────────────────────────────┐
│  Hash Set                               │
├─────────────────────────────────────────┤
│  [EMPTY]  ← All hashes cleared!         │
│  ⚠️ Lost deduplication!                 │
└─────────────────────────────────────────┘
```

### New Behavior (Time-Based Cleanup)
```
┌─────────────────────────────────────────┐
│  Hash Map                               │
├─────────────────────────────────────────┤
│  abc123: timestamp 10:30:00             │
│  def456: timestamp 10:30:15             │
│  ghi789: timestamp 10:30:30             │
└─────────────────────────────────────────┘
                  │
                  │ Flush triggered at 10:30:40
                  ↓
┌─────────────────────────────────────────┐
│  Hash Map                               │
├─────────────────────────────────────────┤
│  abc123: timestamp 10:30:00             │
│  def456: timestamp 10:30:15             │
│  ghi789: timestamp 10:30:30             │
│  ✅ Hashes preserved!                   │
└─────────────────────────────────────────┘
                  │
                  │ New event at 10:31:05
                  │ Cleanup old hashes (> 60s)
                  ↓
┌─────────────────────────────────────────┐
│  Hash Map                               │
├─────────────────────────────────────────┤
│  [abc123 removed - 65s old]             │
│  def456: timestamp 10:30:15 (50s old)   │
│  ghi789: timestamp 10:30:30 (35s old)   │
│  jkl012: timestamp 10:31:05 (new)       │
│  ✅ Auto cleanup!                       │
└─────────────────────────────────────────┘
```

## Real-World Transaction Flow

### Typical Transaction Lifecycle

```
User Action                 SDK Event                    Status
─────────────────────────────────────────────────────────────────

User clicks                 
"Submit" button             
    │                       
    ↓                       
[App calls                  track("transaction_submit")  ✅ Queued
 analytics.track]           Hash: xxx111                 Time: 0s
    │                       
    ↓                       
[User confirms              
 in wallet]                 
    │                       
    ↓                       
[Transaction                track("transaction_success") ✅ Queued
 success]                   Hash: yyy222                 Time: 5s
    │                       Different event name!        
    ↓                       
                            
── React re-renders ────────
    │                       
    ↓                       
[Component                  track("transaction_submit")  ❌ BLOCKED
 re-renders]                Hash: xxx111                 "Sent 7s ago"
    │                       Same as first!               
    ↓                       
                            
── User does another txn ───
    │                       
    ↓                       
User clicks                 
"Submit" again              
    │                       
    ↓                       
[App calls                  track("transaction_submit")  ✅ Queued
 analytics.track]           Hash: zzz333                 Time: 70s
    │                       Outside 60s window!          
    ↓                       

Result: 3 events sent (submit #1, success, submit #2)
        1 event blocked (duplicate submit)
```

## Data Flow Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Your Application                                            │
│                                                              │
│  analytics.track("transaction_submit", { type: "swap" })    │
│                                     │                        │
└─────────────────────────────────────┼────────────────────────┘
                                      │
                                      ↓
┌──────────────────────────────────────────────────────────────┐
│  EventManager.addEvent()                                     │
│  - Validates event                                           │
│  - Adds user context                                         │
│                                     │                        │
└─────────────────────────────────────┼────────────────────────┘
                                      │
                                      ↓
┌──────────────────────────────────────────────────────────────┐
│  EventQueue.enqueue()                                        │
│                                                              │
│  1. generateMessageId()                                      │
│     - Format timestamp to second precision                   │
│     - Stringify event with formatted timestamp               │
│     - Generate SHA-256 hash                                  │
│                                                              │
│  2. isDuplicate()                                            │
│     - Clean up old hashes (> 60s)                            │
│     - Check if hash exists                                   │
│       YES → Block event, log warning                         │
│       NO  → Add to queue, store hash with timestamp          │
│                                     │                        │
└─────────────────────────────────────┼────────────────────────┘
                                      │
                                      ↓ (When flush conditions met)
┌──────────────────────────────────────────────────────────────┐
│  EventQueue.flush()                                          │
│  - Batch events                                              │
│  - Send to API                                               │
│  - DON'T clear hash map (preserved for deduplication)        │
│                                     │                        │
└─────────────────────────────────────┼────────────────────────┘
                                      │
                                      ↓
┌──────────────────────────────────────────────────────────────┐
│  Analytics API                                               │
│  - Receives only unique events                               │
│  - No server-side deduplication needed                       │
└──────────────────────────────────────────────────────────────┘
```

## Memory Management

```
Hash Map Growth Over Time:

Minute 0:
┌──────────┐
│ 5 events │  ~40 bytes per entry = 200 bytes
└──────────┘

Minute 1:
┌──────────┐
│ 5 events │  (new)
├──────────┤
│ 5 events │  (from minute 0, still < 60s old)
└──────────┘
Total: 10 events = 400 bytes

Minute 2:
┌──────────┐
│ 5 events │  (new)
├──────────┤
│ 5 events │  (from minute 1, still < 60s old)
├──────────┤
│ 0 events │  (from minute 0, CLEANED - > 60s)
└──────────┘
Total: 10 events = 400 bytes (stable!)

Even with 1000 events per minute:
- Only 1 minute of events stored
- ~40 bytes per entry
- 1000 events × 40 bytes = 40 KB
- Minimal memory impact!
```

## Key Takeaways

1. **Hashes persist across flushes** - No more duplicate events after queue flush
2. **60-second window** - Recent duplicates caught, old events allowed
3. **Second-level precision** - Better granularity than minute-level
4. **Auto cleanup** - No manual intervention needed, memory efficient
5. **Clear warnings** - Know when duplicates are blocked

## Visual Cheat Sheet

```
✅ ALLOWED                         ❌ BLOCKED
─────────────────────────────      ─────────────────────────────
• Different event names            • Same event within 60s
• Different properties             • Identical all fields
• Outside 60s window               • Within deduplication window
• Different addresses/users        • Rapid fire (< 1s apart)
```

