# Solana Wallet Integration

This document describes how to integrate Solana wallet tracking with the Formo Analytics SDK.

## Overview

The Formo SDK supports tracking Solana wallet events alongside EVM wallet events, enabling comprehensive analytics for multi-chain applications. The integration works with the standard `@solana/wallet-adapter-react` library.

## Features

- **Wallet Detection**: Automatically detects installed Solana wallets (Phantom, Solflare, Backpack, etc.)
- **Connection Tracking**: Tracks wallet connect/disconnect events
- **Signature Tracking**: Monitors message signing operations
- **Transaction Tracking**: Monitors transaction sends
- **Multi-Chain Support**: Works alongside EVM wallet tracking (Wagmi, EIP-1193)
- **Network Awareness**: Tracks the Solana cluster (mainnet-beta, devnet, testnet, localnet)

## Installation

The Solana integration requires `@solana/wallet-adapter-react` as an optional peer dependency:

```bash
npm install @solana/wallet-adapter-react @solana/wallet-adapter-wallets
# or
pnpm add @solana/wallet-adapter-react @solana/wallet-adapter-wallets
```

## Quick Start

### Method 1: Provider Configuration (Recommended)

Configure Solana tracking via the `FormoAnalyticsProvider`:

```tsx
import { FormoAnalyticsProvider } from '@formo/analytics';
import { useWallet } from '@solana/wallet-adapter-react';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-wallets';

// Your wallet setup
const wallets = [new PhantomWalletAdapter()];

function App() {
  return (
    <ConnectionProvider endpoint="https://api.mainnet-beta.solana.com">
      <WalletProvider wallets={wallets} autoConnect>
        <FormoWithSolana />
      </WalletProvider>
    </ConnectionProvider>
  );
}

function FormoWithSolana() {
  const wallet = useWallet();

  return (
    <FormoAnalyticsProvider
      writeKey="wk_your_write_key"
      options={{
        solana: {
          wallet,
          cluster: 'mainnet-beta',
          pollIntervalMs: 500, // Optional: customize poll interval
          onReady: () => console.log('Solana tracking ready')
        }
      }}
    >
      <YourApp />
    </FormoAnalyticsProvider>
  );
}
```

### Method 2: Using the Hook

For more control, use the `useSolanaFormo` hook:

```tsx
import { FormoAnalyticsProvider, useSolanaFormo } from '@formo/analytics';
import { useWallet } from '@solana/wallet-adapter-react';

function MyComponent() {
  const wallet = useWallet();

  const {
    isConnected,
    address,
    trackSignature,
    trackTransaction,
    updateCluster
  } = useSolanaFormo({
    wallet,
    cluster: 'mainnet-beta',
    enabled: true // Can conditionally enable/disable
  });

  // Manual tracking example
  const handleCustomSign = async () => {
    await trackSignature({
      status: 'confirmed',
      message: 'Custom message',
      signatureHash: 'signature_here'
    });
  };

  return (
    <div>
      <p>Connected: {isConnected ? 'Yes' : 'No'}</p>
      <p>Address: {address}</p>
      <button onClick={() => updateCluster('devnet')}>
        Switch to Devnet
      </button>
    </div>
  );
}
```

## Multi-Chain Setup

Track both Solana and EVM wallets in the same application:

```tsx
import { FormoAnalyticsProvider } from '@formo/analytics';
import { useWallet } from '@solana/wallet-adapter-react';
import { useConfig } from 'wagmi';

function MultiChainApp() {
  const solanaWallet = useWallet();
  const wagmiConfig = useConfig();

  return (
    <FormoAnalyticsProvider
      writeKey="wk_your_write_key"
      options={{
        // EVM wallet tracking via Wagmi
        wagmi: {
          config: wagmiConfig
        },
        // Solana wallet tracking
        solana: {
          wallet: solanaWallet,
          cluster: 'mainnet-beta'
        }
      }}
    >
      <YourApp />
    </FormoAnalyticsProvider>
  );
}
```

## Configuration Options

### SolanaOptions

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `wallet` | `SolanaWalletAdapter` | (required) | The wallet adapter from `useWallet()` |
| `cluster` | `SolanaCluster` | `"mainnet-beta"` | Current Solana network |
| `pollIntervalMs` | `number` | `500` | Polling interval for state changes (100-5000ms) |
| `onReady` | `() => void` | - | Callback when handler is initialized |

### Supported Clusters

| Cluster | Pseudo Chain ID | Description |
|---------|-----------------|-------------|
| `mainnet-beta` | `101` | Solana Mainnet |
| `devnet` | `102` | Solana Devnet |
| `testnet` | `103` | Solana Testnet |
| `localnet` | `104` | Local validator |

## Events Tracked

### Wallet Detection (`detect`)

Emitted when a wallet provider is detected.

```json
{
  "type": "detect",
  "properties": {
    "providerName": "Phantom",
    "rdns": "app.phantom.solana"
  }
}
```

### Wallet Connection (`connect`)

Emitted when a wallet connects.

```json
{
  "type": "connect",
  "properties": {
    "chainId": 101,
    "address": "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV",
    "providerName": "Phantom",
    "blockchain": "solana",
    "cluster": "mainnet-beta"
  }
}
```

### Wallet Disconnection (`disconnect`)

Emitted when a wallet disconnects.

```json
{
  "type": "disconnect",
  "properties": {
    "chainId": 101,
    "address": "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV",
    "blockchain": "solana",
    "cluster": "mainnet-beta"
  }
}
```

### Network Change (`chain`)

Emitted when the cluster is updated via `updateCluster()`.

```json
{
  "type": "chain",
  "properties": {
    "chainId": 102,
    "address": "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV",
    "blockchain": "solana",
    "cluster": "devnet"
  }
}
```

### Signature Events (`signature`)

Emitted when signing messages. Status can be: `requested`, `confirmed`, `rejected`.

```json
{
  "type": "signature",
  "properties": {
    "status": "confirmed",
    "chainId": 101,
    "address": "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV",
    "message": "Sign this message",
    "signatureHash": "5KtP..."
  }
}
```

### Transaction Events (`transaction`)

Emitted when sending transactions. Status can be: `started`, `broadcasted`, `rejected`.

```json
{
  "type": "transaction",
  "properties": {
    "status": "broadcasted",
    "chainId": 101,
    "address": "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV",
    "transactionHash": "5wHs3..."
  }
}
```

## Address Utilities

The SDK provides utilities for working with Solana addresses:

```typescript
import {
  isValidSolanaAddress,
  getValidSolanaAddress,
  isBlockedSolanaAddress,
  detectAddressType,
  shortenSolanaAddress
} from '@formo/analytics';

// Validate Solana address format
isValidSolanaAddress("7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV"); // true
isValidSolanaAddress("0x123..."); // false (EVM address)

// Get validated and trimmed address
getValidSolanaAddress("  7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV  ");
// Returns: "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV"

// Check if address is a system program (blocked)
isBlockedSolanaAddress("11111111111111111111111111111111"); // true

// Detect address type
detectAddressType("7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV"); // "solana"
detectAddressType("0x742d35Cc6634C0532925a3b844Bc454e4438f44e"); // "evm"

// Shorten address for display
shortenSolanaAddress("7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV");
// Returns: "7EcD...LtV"
```

## Known Wallets

The SDK recognizes these Solana wallets with predefined RDNS identifiers:

| Wallet | RDNS |
|--------|------|
| Phantom | `app.phantom.solana` |
| Solflare | `com.solflare` |
| Backpack | `app.backpack` |
| Glow | `app.glow` |
| Coinbase Wallet | `com.coinbase.wallet.solana` |
| Trust Wallet | `com.trustwallet.solana` |
| Ledger | `com.ledger.solana` |
| Torus | `app.torus.solana` |
| MathWallet | `com.mathwallet.solana` |
| Slope | `com.slope.solana` |
| BitKeep | `com.bitkeep.solana` |
| Exodus | `com.exodus.solana` |

Unknown wallets are assigned a generated RDNS like `app.walletname.solana`.

## Autocapture Configuration

Control which events are tracked using the `autocapture` option:

```tsx
<FormoAnalyticsProvider
  writeKey="wk_xxx"
  options={{
    autocapture: {
      connect: true,      // Track connect events
      disconnect: true,   // Track disconnect events
      signature: true,    // Track signature events
      transaction: true,  // Track transaction events
      chain: true         // Track network/cluster changes
    },
    solana: {
      wallet,
      cluster: 'mainnet-beta'
    }
  }}
>
```

## How It Works

### State Polling

Unlike EVM wallets that use event subscriptions, the Solana wallet adapter doesn't expose events for connection state changes. The SDK uses polling to detect:

1. **Connection changes**: Checks `wallet.connected` state
2. **Account changes**: Monitors `wallet.publicKey` for address changes
3. **Transition states**: Skips events during `connecting` or `disconnecting`

The default poll interval is 500ms, configurable via `pollIntervalMs` (100-5000ms range).

### Method Wrapping

For signature and transaction tracking, the SDK wraps the wallet methods:

- `wallet.signMessage` - Wrapped to track signature events
- `wallet.sendTransaction` - Wrapped to track transaction events

Original methods are restored on cleanup.

## TypeScript Types

```typescript
import type {
  SolanaOptions,
  SolanaCluster,
  SolanaWalletAdapter,
  SolanaSignatureParams,
  SolanaTransactionParams,
  UseSolanaFormoOptions,
  UseSolanaFormoReturn
} from '@formo/analytics';

// Chain ID constants
import { SOLANA_CHAIN_IDS, KNOWN_SOLANA_WALLETS } from '@formo/analytics';
```

## Troubleshooting

### Wallet not being detected

Ensure the wallet provider is properly set up before the FormoAnalyticsProvider:

```tsx
// Correct order
<ConnectionProvider>
  <WalletProvider>
    <FormoAnalyticsProvider>
      <App />
    </FormoAnalyticsProvider>
  </WalletProvider>
</ConnectionProvider>
```

### Events not tracking

1. Check that `autocapture` is not disabled for the specific event type
2. Verify the wallet is connected before expecting signature/transaction events
3. Check browser console for error messages from `SolanaEventHandler`

### Multiple handlers

If you're using both provider configuration and the hook, events may be tracked twice. Choose one method:

- Use `options.solana` in provider for automatic setup
- OR use `useSolanaFormo` hook for manual control (don't configure both)

## Migration from EVM-Only Setup

If your app was previously tracking only EVM wallets, adding Solana support is additive:

```tsx
// Before: EVM only
<FormoAnalyticsProvider
  writeKey="wk_xxx"
  options={{
    wagmi: { config: wagmiConfig }
  }}
>

// After: EVM + Solana
<FormoAnalyticsProvider
  writeKey="wk_xxx"
  options={{
    wagmi: { config: wagmiConfig },
    solana: { wallet: solanaWallet, cluster: 'mainnet-beta' }
  }}
>
```

Both integrations work independently and events are tagged with `blockchain: "solana"` or the EVM chain ID for easy filtering in analytics.
