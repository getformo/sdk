# Autocapture Flow Diagram

## Overview Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    FormoAnalytics.init()                     │
│                                                               │
│  Options: {                                                   │
│    autocapture: {                                       │
│      enabled: boolean                                         │
│      events: { connect, disconnect, signature, tx, chain }   │
│    }                                                           │
│  }                                                             │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
            ┌────────────────────────┐
            │  isWalletAutocapture   │
            │     Enabled()?         │
            └─────────┬──────────────┘
                      │
         ┌────────────┴───────────┐
         │                        │
    NO   ▼                        ▼   YES
  ┌──────────────┐        ┌──────────────────┐
  │ Skip all     │        │ Register          │
  │ listener     │        │ listeners         │
  │ registration │        │ conditionally     │
  └──────────────┘        └──────┬───────────┘
                                  │
                     ┌────────────┴────────────┐
                     │  For each event type:   │
                     │  isWalletEventEnabled() │
                     └────────────┬────────────┘
                                  │
           ┌──────────────────────┼──────────────────────┐
           │                      │                       │
      connect/disconnect        chain                signature/tx
           │                      │                       │
           ▼                      ▼                       ▼
    ┌─────────────────┐  ┌──────────────┐     ┌─────────────────┐
    │ accountsChanged │  │ chainChanged │     │ wrap provider   │
    │ connect         │  │ listener     │     │ .request method │
    │ disconnect      │  │              │     │                 │
    │ listeners       │  │              │     │                 │
    └─────────────────┘  └──────────────┘     └─────────────────┘
```

## Event Flow - Connect/Disconnect

```
┌─────────────────────────────────────────────────────────────┐
│                  Wallet Connection Event                     │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
            ┌────────────────────────┐
            │  accountsChanged       │
            │  event fired           │
            └─────────┬──────────────┘
                      │
                      ▼
            ┌────────────────────────┐
            │  onAccountsChanged()   │
            └─────────┬──────────────┘
                      │
         ┌────────────┴───────────┐
         │                        │
    Empty array              Has accounts
         │                        │
         ▼                        ▼
  ┌──────────────┐        ┌──────────────────┐
  │ Disconnect   │        │ Connect          │
  │ detected     │        │ detected         │
  └──────┬───────┘        └──────┬───────────┘
         │                       │
         ▼                       ▼
  ┌──────────────┐        ┌──────────────────┐
  │ isWalletEvent│        │ isWalletEvent    │
  │ Enabled      │        │ Enabled          │
  │ ('disconnect')│       │ ('connect')?     │
  └──────┬───────┘        └──────┬───────────┘
         │                       │
    YES  ▼                  YES  ▼
  ┌──────────────┐        ┌──────────────────┐
  │ Track        │        │ Track            │
  │ disconnect   │        │ connect event    │
  │ event        │        │                  │
  └──────────────┘        └──────────────────┘
```

## Event Flow - Signature

```
┌─────────────────────────────────────────────────────────────┐
│           User initiates signature request                   │
│           (personal_sign, eth_signTypedData_v4)             │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
            ┌────────────────────────┐
            │  provider.request()    │
            │  intercepted by        │
            │  wrappedRequest        │
            └─────────┬──────────────┘
                      │
                      ▼
            ┌────────────────────────┐
            │  isWalletEventEnabled  │
            │  ('signature')?        │
            └─────────┬──────────────┘
                      │
         ┌────────────┴───────────┐
         │                        │
    NO   ▼                   YES  ▼
  ┌──────────────┐        ┌──────────────────┐
  │ Pass through │        │ Track REQUESTED  │
  │ to original  │        │ status           │
  │ request      │        └──────┬───────────┘
  └──────────────┘               │
                                 ▼
                        ┌──────────────────┐
                        │ Execute original │
                        │ request          │
                        └────────┬─────────┘
                                 │
                    ┌────────────┴────────────┐
                    │                         │
              Success                    Rejected (4001)
                    │                         │
                    ▼                         ▼
          ┌──────────────────┐     ┌──────────────────┐
          │ Track CONFIRMED  │     │ Track REJECTED   │
          └──────────────────┘     └──────────────────┘
```

## Event Flow - Transaction

```
┌─────────────────────────────────────────────────────────────┐
│           User initiates transaction                         │
│           (eth_sendTransaction)                              │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
            ┌────────────────────────┐
            │  provider.request()    │
            │  intercepted           │
            └─────────┬──────────────┘
                      │
                      ▼
            ┌────────────────────────┐
            │  isWalletEventEnabled  │
            │  ('transaction')?      │
            └─────────┬──────────────┘
                      │
         ┌────────────┴───────────┐
         │                        │
    NO   ▼                   YES  ▼
  ┌──────────────┐        ┌──────────────────┐
  │ Pass through │        │ Track STARTED    │
  │              │        │ status           │
  └──────────────┘        └──────┬───────────┘
                                 │
                                 ▼
                        ┌──────────────────┐
                        │ Execute tx       │
                        └────────┬─────────┘
                                 │
                    ┌────────────┴────────────┐
                    │                         │
              Success                    Rejected (4001)
                    │                         │
                    ▼                         ▼
          ┌──────────────────┐     ┌──────────────────┐
          │ Track BROADCASTED│     │ Track REJECTED   │
          │ + tx hash        │     └──────────────────┘
          └────────┬─────────┘
                   │
                   ▼
          ┌──────────────────┐
          │ Poll for receipt │
          │ (async)          │
          └────────┬─────────┘
                   │
      ┌────────────┴────────────┐
      │                         │
   Receipt                   Receipt
   status: 1                status: 0
      │                         │
      ▼                         ▼
┌──────────────────┐     ┌──────────────────┐
│ Track CONFIRMED  │     │ Track REVERTED   │
└──────────────────┘     └──────────────────┘
```

## Configuration Decision Tree

```
                    Initialize SDK
                         │
                         ▼
          ┌──────────────────────────┐
          │ autocapture config │
          └─────────┬────────────────┘
                    │
     ┌──────────────┼──────────────┐
     │              │              │
undefined         false         object
     │              │              │
     ▼              ▼              ▼
┌─────────┐  ┌──────────┐  ┌────────────┐
│ Default │  │ Disable  │  │ Check      │
│ (all    │  │ all      │  │ 'enabled'  │
│ enabled)│  │ events   │  │ property   │
└─────────┘  └──────────┘  └─────┬──────┘
                                  │
                     ┌────────────┴────────────┐
                     │                         │
                undefined                  true/false
                     │                         │
                     ▼                         ▼
              ┌─────────────┐         ┌──────────────┐
              │ Default to  │         │ Use explicit │
              │ enabled     │         │ value        │
              └──────┬──────┘         └──────┬───────┘
                     │                       │
                     └───────────┬───────────┘
                                 │
                                 ▼
                    ┌────────────────────────┐
                    │ For each event type    │
                    └─────────┬──────────────┘
                              │
                 ┌────────────┼────────────┐
                 │            │            │
           undefined       true        false
                 │            │            │
                 ▼            ▼            ▼
          ┌──────────┐  ┌─────────┐  ┌─────────┐
          │ Default  │  │ Enable  │  │ Disable │
          │ to true  │  │ event   │  │ event   │
          └──────────┘  └─────────┘  └─────────┘
```

## Listener Registration Flow

```
                trackProvider(provider)
                         │
                         ▼
           ┌─────────────────────────┐
           │ Already tracked?        │
           └──────┬──────────────────┘
                  │
         ┌────────┴─────────┐
        YES                 NO
         │                  │
         ▼                  ▼
    ┌────────┐    ┌─────────────────────┐
    │ Return │    │ isWalletAutocapture │
    │        │    │ Enabled()?          │
    └────────┘    └──────┬──────────────┘
                         │
              ┌──────────┴──────────┐
             NO                    YES
              │                     │
              ▼                     ▼
    ┌────────────────┐   ┌──────────────────────┐
    │ Add to tracked │   │ Check each event type│
    │ (no listeners) │   └──────┬───────────────┘
    └────────────────┘          │
                                │
         ┌──────────────────────┼──────────────────────┐
         │                      │                       │
         ▼                      ▼                       ▼
┌────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│ connect or     │    │ chain enabled?  │    │ sig or tx       │
│ disconnect?    │    │                 │    │ enabled?        │
└────────┬───────┘    └────────┬────────┘    └────────┬────────┘
         │                     │                       │
        YES                   YES                     YES
         │                     │                       │
         ▼                     ▼                       ▼
┌────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│ Register       │    │ Register        │    │ Register        │
│ accountsChanged│    │ chainChanged    │    │ request wrapper │
│ + connect/     │    │ listener        │    │                 │
│ disconnect     │    │                 │    │                 │
└────────────────┘    └─────────────────┘    └─────────────────┘
         │                     │                       │
         └─────────────────────┴───────────────────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │ Add to tracked set   │
                    └──────────────────────┘
```

## Performance Comparison

```
┌─────────────────────────────────────────────────────────────┐
│                    All Events Enabled                        │
├─────────────────────────────────────────────────────────────┤
│ Listeners per provider: 5                                    │
│ - accountsChanged                                            │
│ - chainChanged                                               │
│ - connect                                                    │
│ - disconnect                                                 │
│ - provider.request wrapper                                   │
│                                                              │
│ RPC Overhead: Every call intercepted                         │
│ Memory: ~5KB per provider                                    │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│              Signature + Transaction Disabled                │
├─────────────────────────────────────────────────────────────┤
│ Listeners per provider: 4                                    │
│ - accountsChanged                                            │
│ - chainChanged                                               │
│ - connect                                                    │
│ - disconnect                                                 │
│                                                              │
│ RPC Overhead: None                                           │
│ Memory: ~3KB per provider                                    │
│ Savings: ~40% memory, 100% RPC overhead                     │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                  All Events Disabled                         │
├─────────────────────────────────────────────────────────────┤
│ Listeners per provider: 0                                    │
│                                                              │
│ RPC Overhead: None                                           │
│ Memory: ~500 bytes per provider (tracking only)             │
│ Savings: ~90% memory, 100% RPC overhead                     │
└─────────────────────────────────────────────────────────────┘
```

## Legend

```
┌──────┐
│ Box  │  = Process/Decision
└──────┘

   │     = Flow direction
   ▼

   ┬     = Split/Branch
 ──┴──

YES/NO   = Decision result
```

## Notes

1. **Listener Registration**: Happens during `trackProvider()` call
2. **Event Checking**: Happens at event emission time
3. **Request Wrapper**: Only installed if signature OR transaction tracking enabled
4. **Performance**: No overhead for disabled events
5. **Memory**: Reduced footprint when events disabled
6. **Backward Compatible**: Default behavior unchanged

## See Also

- **Quick Reference**: `AUTOCAPTURE_QUICK_REFERENCE.md`
- **Comprehensive Guide**: `AUTOCAPTURE.md`
- **Implementation**: `src/FormoAnalytics.ts`
- **Types**: `src/types/base.ts`

