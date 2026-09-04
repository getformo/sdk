# Solana Integration for Formo Analytics SDK

## Overview

The SDK discovers EVM wallets through EIP-6963 and compatible Solana wallets
through the [Wallet Standard](https://github.com/wallet-standard/wallet-standard).
This captures wallet events regardless of whether the app uses
`@solana/wallet-adapter`, framework-kit, Privy, Dynamic, Reown, or a custom
connector.

Apps that use framework-kit (`@solana/client`) can additionally pass its
zustand store, which adds the transaction lifecycle and cluster switches.

## Design Principles

1. **On by default**: Solana discovery runs unless `solana: false` is passed,
   exactly like EVM discovery runs unless `evm: false` is passed. A customer
   who never configures Solana still gets their connects. (Before this, Solana
   capture was opt-in and manual, and a paying customer ran for months with
   tens of thousands of Solana wallets and zero connect events.)
2. **No wallet library dependency**: the Wallet Standard handshake is a few
   lines of window events, implemented inline and duck-typed. The SDK keeps
   its two runtime dependencies.
3. **Read-only observer**: no wallet method is wrapped, no request is issued
   to a wallet. The SDK subscribes to `standard:events` and diffs accounts.
4. **Consistent event model**: the same `detect`, `connect`, `disconnect` and
   `chain` events as EVM, with Solana clusters mapped to reserved chain ids.
5. **One connect per connection**: when both sources see a connection, one
   of them reports it.

## Architecture

```
Wallet Standard wallets (Phantom, Solflare, ...)      framework-kit client.store
        │  window events + standard:events                   │  zustand subscribe
        ▼                                                    ▼
SolanaWalletStandardRegistry                          SolanaStoreHandler
  detect / connect / disconnect / chain                connect / disconnect /
                                                       chain / transaction
        └──────────────────┬─────────────────────────────────┘
                           ▼
                     SolanaManager
                           ▼
                    FormoAnalytics
```

### `SolanaWalletStandardRegistry` (`src/solana/SolanaWalletStandardRegistry.ts`)

The Solana analogue of `EvmProviderRegistry` + EIP-6963.

- **Discovery**: dispatches `wallet-standard:app-ready` with a `register`
  API and listens for `wallet-standard:register-wallet`. Both directions are
  needed because a wallet extension and the app bundle race on every page
  load. Wallets that list no `solana:` chain are ignored.
- **Detect**: emitted once per discovered wallet; the SDK dedupes per session
  on `rdns`.
- **Connect / disconnect**: subscribes to each wallet's `standard:events`
  `change` event and diffs its `accounts`. None to some is a connect, some to
  none a disconnect, a different first account is a disconnect then a
  connect. Without a configured framework-kit store, a wallet that is already
  authorized when discovered is reported as connected at once. With a store,
  the store reports that initial connection instead. On a multichain wallet
  only accounts whose `chains` include a Solana chain are considered.
- **Cluster**: the Wallet Standard lists the clusters a wallet supports, not
  the one the app is on. The registry uses `options.solana.cluster` when
  given, else mainnet-beta when supported, else the first Solana cluster
  listed. `formo.solana.setCluster()` re-tags a live connection and emits
  `chain`.
- **Teardown**: removes its window listener, unsubscribes from every wallet,
  and refuses late registrations through the API a wallet kept.

### `SolanaStoreHandler` (`src/solana/SolanaStoreHandler.ts`)

Subscribes to framework-kit's `client.store` and reports connect, disconnect,
cluster changes (detected from the endpoint URL) and the transaction
lifecycle (`sending` → STARTED, `waiting` → BROADCASTED, `confirmed` →
CONFIRMED, `failed` → REJECTED or REVERTED).

### `SolanaManager` (`src/solana/SolanaManager.ts`)

Owns both. A store supplied at initialization owns wallet events from the
outset. A store attached later takes ownership when it observes its first
connection, adopting any connect the registry already reported. The registry
continues discovering wallets and emitting `detect`; once the store owns the
connection, connect and disconnect come from the store because it knows the
cluster and connector more precisely.

### Types

- `src/solana/walletStandardTypes.ts`: the subset of the Wallet Standard the
  SDK reads, duck-typed.
- `src/solana/storeTypes.ts`: the subset of framework-kit's store state the
  SDK reads. `client.store` must be assignable to `SolanaClientStore` without
  a cast; a type-only check against `@solana/client` is the way to confirm
  this after either side changes.
- `src/solana/types.ts`: clusters, chain ids, `SolanaOptions`, and
  `solanaWalletRdns()`.

## Options

```ts
solana?: boolean | SolanaOptions;

interface SolanaOptions {
  /** framework-kit's client.store. Adds transactions and cluster switches. */
  store?: SolanaClientStore;
  /** The cluster the app is on. Needed without a store for non-mainnet apps. */
  cluster?: SolanaCluster;
}
```

| Configuration | Discovery | Connect / disconnect | Transactions |
|---|---|---|---|
| nothing (default) | Wallet Standard | registry | manual `formo.transaction()` |
| `solana: { cluster }` | Wallet Standard | registry, on that cluster | manual |
| `solana: { store }` | Wallet Standard (detect only) | store | store |
| `solana: false` | off | manual `formo.connect()` | manual |

Signatures (`signMessage`, `signTransaction`) are reported by neither
source; call `formo.signature()`.

The global `autocapture.connect`, `disconnect`, `chain`, and `transaction`
flags still gate events from both sources.

## Chain ID Mapping

Solana has no numeric chain id. Clusters map to reserved ids above 900000:

| Cluster | Chain ID |
|---------|----------|
| mainnet-beta | 900001 |
| testnet | 900002 |
| devnet | 900003 |
| localnet | 900004 |

`SOLANA_CHAIN_IDS` and `isSolanaChainId()` are exported.

## Wallet Identification

The Wallet Standard has no reverse-domain identifier, so one is derived from
the wallet name by `solanaWalletRdns()`: lowercase the name, remove whitespace,
URL-encode the result, and prefix it with `sol.wallet.`. This preserves the
historical framework-kit identifiers while keeping cookie delimiters safe.
Names that differ only by case or whitespace intentionally share a session
dedup key. Both sources derive the identifier the same way so a wallet's
`detect` and its `connect` share one rdns whichever source reported each.

Examples:

- Phantom: `sol.wallet.phantom`
- Solflare: `sol.wallet.solflare`
- Backpack: `sol.wallet.backpack`

## Address Handling

Solana public keys are 32-byte, Base58-encoded values. The SDK accepts 32 to
44 characters from the Base58 alphabet (which excludes `0`, `O`, `I`, and
`l`) and compares them case-sensitively. For example:

`FDKJvWcJNe6wecbgDYDFPCfgs14aJnVsUfWQRYWLn4Tn`

Validation checks format, not Ed25519 curve membership. `connect()` also
checks the chain id, so a Base58 address paired with an EVM chain is rejected.

The SDK blocks these non-wallet addresses:

| Address | Value |
|---|---|
| System Program | `11111111111111111111111111111111` |
| Token Program | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` |
| Token-2022 Program | `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` |
| Associated Token Program | `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL` |
| Rent Sysvar | `SysvarRent111111111111111111111111111111111` |
| Clock Sysvar | `SysvarC1ock11111111111111111111111111111111` |

The list and validation helpers are defined in `src/solana/address.ts`.

## Limitations

1. **Cluster without a store**: the standard cannot say which cluster the
   app uses. Non-mainnet apps without a store should pass `cluster` or call
   `setCluster()`.
2. **No signature capture**: neither source reports `signMessage` or
   `signTransaction`.
3. **No transaction capture without a store**: only framework-kit's store
   exposes the transaction lifecycle.
4. **No program decoding**: function names and arguments are not extracted
   from Solana instructions.

## Testing

- `test/solana/SolanaWalletStandardRegistry.spec.ts`: discovery in both
  handshake directions, account diffing, multichain wallets, cluster
  handling, coexistence with a store, teardown.
- `test/solana/SolanaManager.spec.ts`: one connect per connection when both
  sources see it, the `solana` option, an end-to-end wallet-adapter style
  connection through `FormoAnalytics.init`.
- `test/solana/SolanaStoreHandler.spec.ts`: the framework-kit store path.

A fake wallet for tests needs `name`, `chains` with a `solana:` entry,
`features['standard:events'].on`, and an `accounts` array; register it by
dispatching `wallet-standard:register-wallet` with a callback `detail`.

## Resources

- [Wallet Standard](https://github.com/wallet-standard/wallet-standard)
- [framework-kit](https://github.com/solana-foundation/framework-kit)
- [Solana Wallet Adapter](https://github.com/anza-xyz/wallet-adapter)
- [Formo docs: Solana integration](https://docs.formo.so/sdks/web#solana-integration)
