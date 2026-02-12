# Solana Integration for Formo Analytics SDK

## Overview

The Formo Analytics SDK now supports integration with [Solana Wallet Adapter](https://github.com/anza-xyz/wallet-adapter), the standard library for Solana wallet integration. This allows tracking of Solana wallet events (connect, disconnect, signatures, and transactions) alongside existing EVM wallet tracking.

## Design Philosophy

### Core Principles

1. **Opt-in Configuration**: Solana integration is completely optional and only activated when explicitly configured
2. **Additive, Not Replacement**: Solana tracking works alongside EVM tracking (not mutually exclusive like Wagmi mode)
3. **Consistent Event Model**: Reuses the same event types (connect, disconnect, signature, transaction) for Solana
4. **Chain-Agnostic Address Type**: Addresses are stored as strings, supporting both EVM (hex) and Solana (Base58)

### Why Solana Support?

- **Multi-Chain Apps**: Many dApps support both EVM and Solana chains
- **Growing Ecosystem**: Solana has a large and growing developer ecosystem
- **User Demand**: Users increasingly have wallets for multiple chains
- **Unified Analytics**: Track all blockchain interactions in one place

## Architecture

### High-Level Flow

```
Solana Wallet Adapter (Phantom, Solflare, etc.)
                    ↓
         SolanaWalletAdapter
                    ↓
           FormoAnalytics SDK
                    ↓
          Analytics Events API
```

### Key Components

#### 1. **SolanaWalletAdapter** (`src/solana/SolanaWalletAdapter.ts`)

The core orchestrator that hooks into Solana Wallet Adapter's event system:

- **Connection Tracking**: Listens to wallet `connect` and `disconnect` events
- **Method Wrapping**: Wraps `sendTransaction`, `signMessage`, and `signTransaction` for tracking
- **Transaction Confirmation**: Polls for transaction confirmation status
- **Cluster/Network Support**: Maps Solana clusters to chain IDs for consistent tracking

#### 2. **Type Definitions** (`src/solana/types.ts`)

Comprehensive TypeScript interfaces for Solana integration:

- `ISolanaWalletAdapter`: Single wallet adapter interface
- `SolanaWalletContext`: useWallet() hook context interface
- `SolanaCluster`: Network types (mainnet-beta, testnet, devnet, localnet)
- `SOLANA_CHAIN_IDS`: Mapping of clusters to numeric chain IDs
- `SolanaPublicKey`: Solana public key interface

#### 3. **Address Utilities** (`src/solana/address.ts`)

Solana-specific address validation and utilities:

- `isSolanaAddress()`: Validate Base58 format addresses
- `getValidSolanaAddress()`: Get validated address from string or PublicKey
- `isBlockedSolanaAddress()`: Filter system program addresses
- `areSolanaAddressesEqual()`: Case-sensitive address comparison

## Chain ID Mapping

Solana doesn't use chain IDs like EVM. The SDK maps Solana clusters to high numeric IDs to avoid collision:

| Cluster | Chain ID | Description |
|---------|----------|-------------|
| mainnet-beta | 900001 | Solana mainnet |
| testnet | 900002 | Solana testnet |
| devnet | 900003 | Solana devnet |
| localnet | 900004 | Local validator |

These IDs are intentionally high (900000+) to avoid collision with any EVM chain IDs.

## Event Mapping

### Connection Events

| Wallet Adapter Event | Formo Event | Details |
|---------------------|-------------|---------|
| `connect` | `connect()` | Emitted when wallet connects with address and cluster-based chainId |
| `disconnect` | `disconnect()` | Emitted when wallet disconnects |

### Signature Events

| Method | Formo Event | Status Mapping |
|--------|-------------|----------------|
| `signMessage()` | `signature()` | Before call → REQUESTED<br>Success → CONFIRMED<br>Error → REJECTED |
| `signTransaction()` | `signature()` | Before call → REQUESTED<br>Success → CONFIRMED<br>Error → REJECTED |

### Transaction Events

| Method | Formo Event | Status Mapping |
|--------|-------------|----------------|
| `sendTransaction()` | `transaction()` | Before call → STARTED<br>Signature returned → BROADCASTED<br>Confirmed on-chain → CONFIRMED<br>Error → REJECTED/REVERTED |

### Transaction Event Lifecycle

A typical transaction flow:

```
User initiates sendTransaction
        ↓
    STARTED
        ↓
User approves in wallet
        ↓
    BROADCASTED (signature/hash received)
        ↓
Transaction confirmed on chain
        ↓
    CONFIRMED or REVERTED
```

## Usage

### Basic Setup

```typescript
import { FormoAnalytics } from '@formo/analytics';
import { useWallet } from '@solana/wallet-adapter-react';
import { useConnection } from '@solana/wallet-adapter-react';

// Get wallet context and connection from hooks
const wallet = useWallet();
const { connection } = useConnection();

// Initialize Formo with Solana integration
const formo = await FormoAnalytics.init('YOUR_WRITE_KEY', {
  solana: {
    wallet: wallet,
    connection: connection,
    cluster: 'mainnet-beta',
  },
});
```

### With React

```tsx
import { WalletProvider } from '@solana/wallet-adapter-react';
import { ConnectionProvider } from '@solana/wallet-adapter-react';
import { FormoAnalyticsProvider } from '@formo/analytics';

function App() {
  const wallet = useWallet();
  const { connection } = useConnection();

  return (
    <ConnectionProvider endpoint={clusterApiUrl('mainnet-beta')}>
      <WalletProvider wallets={wallets}>
        <FormoAnalyticsProvider
          writeKey="YOUR_WRITE_KEY"
          options={{
            solana: {
              wallet: wallet,
              connection: connection,
              cluster: 'mainnet-beta',
            },
          }}
        >
          <YourApp />
        </FormoAnalyticsProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
```

### Dynamic Wallet Updates

For React apps where wallet context changes:

```tsx
import { useEffect } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useConnection } from '@solana/wallet-adapter-react';
import { useFormo } from '@formo/analytics';

function WalletTracker() {
  const wallet = useWallet();
  const { connection } = useConnection();
  const formo = useFormo();

  // Update Solana handler when wallet/connection changes
  useEffect(() => {
    formo?.setSolanaWallet(wallet);
  }, [wallet, formo]);

  useEffect(() => {
    formo?.setSolanaConnection(connection);
  }, [connection, formo]);

  return null;
}
```

### Multi-Chain Setup (EVM + Solana)

```typescript
import { createConfig } from 'wagmi';
import { QueryClient } from '@tanstack/react-query';
import { useWallet } from '@solana/wallet-adapter-react';

const wagmiConfig = createConfig({ /* ... */ });
const queryClient = new QueryClient();

const formo = await FormoAnalytics.init('YOUR_WRITE_KEY', {
  // EVM tracking via Wagmi
  wagmi: {
    config: wagmiConfig,
    queryClient: queryClient,
  },
  // Solana tracking
  solana: {
    wallet: solanaWallet,
    connection: solanaConnection,
    cluster: 'mainnet-beta',
  },
});
```

### Autocapture Configuration

Control which events are tracked (applies to both EVM and Solana):

```typescript
const formo = await FormoAnalytics.init('YOUR_WRITE_KEY', {
  solana: {
    wallet: wallet,
    connection: connection,
  },
  autocapture: {
    connect: true,      // Track wallet connections
    disconnect: true,   // Track wallet disconnections
    signature: true,    // Track message signing
    transaction: true,  // Track transactions
  },
});
```

### Cleanup

Always clean up when done:

```typescript
// In React component unmount or app cleanup
useEffect(() => {
  return () => {
    formo.cleanup();
  };
}, [formo]);
```

## Configuration Options

### SolanaOptions Interface

```typescript
interface SolanaOptions {
  /**
   * The Solana wallet adapter instance or wallet context
   * Can be a single wallet adapter or the useWallet() context
   */
  wallet?: ISolanaWalletAdapter | SolanaWalletContext;

  /**
   * The Solana connection for tracking transaction confirmations
   */
  connection?: SolanaConnection;

  /**
   * The Solana cluster/network
   * Chain ID is automatically derived from cluster:
   * - mainnet-beta: 900001
   * - testnet: 900002
   * - devnet: 900003
   * - localnet: 900004
   * @default "mainnet-beta"
   */
  cluster?: SolanaCluster;
}
```

### Connection: Optional but Recommended

The `connection` parameter is optional but recommended for full transaction confirmation tracking:

| Feature | Without Connection | With Connection |
|---------|-------------------|-----------------|
| Connect | ✅ Tracked | ✅ Tracked |
| Disconnect | ✅ Tracked | ✅ Tracked |
| Signatures | ✅ Tracked | ✅ Tracked |
| Transaction Start | ✅ Tracked | ✅ Tracked |
| Transaction Broadcast | ✅ Tracked | ✅ Tracked |
| Transaction Confirmed | ❌ NOT Tracked | ✅ Tracked |
| Transaction Reverted | ❌ NOT Tracked | ✅ Tracked |

## Address Format

Solana addresses are 32-byte Base58-encoded strings:

- **Example**: `FDKJvWcJNe6wecbgDYDFPCfgs14aJnVsUfWQRYWLn4Tn`
- **Length**: 32-44 characters
- **Character Set**: Base58 (no 0, O, I, l)
- **Case Sensitive**: Unlike EVM addresses, Solana addresses ARE case-sensitive

### System Addresses (Blocked)

The SDK blocks events from known system program addresses:

- System Program: `11111111111111111111111111111111`
- Token Program: `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`
- Token-2022 Program: `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`
- Associated Token Program: `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL`

## Comparison: Solana Mode vs EVM Modes

| Feature | Solana Mode | EVM (EIP-1193) | EVM (Wagmi) |
|---------|------------|----------------|-------------|
| **Works Alongside Other Modes** | ✅ Yes | N/A | ✅ Yes |
| **Address Format** | Base58 (32-44 chars) | Hex (42 chars) | Hex (42 chars) |
| **Chain ID Format** | Cluster mapped to number | Native number | Native number |
| **Signature Tracking** | ✅ signMessage, signTransaction | ✅ personal_sign, eth_signTypedData_v4 | ✅ signMessage, signTypedData |
| **Transaction Confirmation** | Polling with connection | Polling with provider | QueryCache |
| **Provider Detection** | Manual (pass wallet) | EIP-6963 auto-detect | Wagmi connectors |
| **React Integration** | Works with wallet-adapter-react | Provider-agnostic | Requires Wagmi context |

## Wallet Identification

The SDK generates an RDNS-like identifier for Solana wallets:

```
sol.wallet.<walletname>
```

Examples:
- Phantom: `sol.wallet.phantom`
- Solflare: `sol.wallet.solflare`
- Backpack: `sol.wallet.backpack`

## Implementation Details

### Method Wrapping

The handler wraps wallet adapter methods to track events:

```typescript
// Original method preserved
this.originalSendTransaction = adapter.sendTransaction.bind(adapter);

// Wrapped method tracks events
adapter.sendTransaction = async (transaction, connection, options) => {
  // Track STARTED
  this.formo.transaction({ status: 'started', ... });

  try {
    const signature = await this.originalSendTransaction(...);
    // Track BROADCASTED
    this.formo.transaction({ status: 'broadcasted', transactionHash: signature, ... });
    // Poll for CONFIRMED/REVERTED
    this.pollTransactionConfirmation(signature, ...);
    return signature;
  } catch (error) {
    // Track REJECTED
    this.formo.transaction({ status: 'rejected', ... });
    throw error;
  }
};
```

### Transaction Confirmation Polling

The handler polls for transaction confirmation using the Solana connection:

```typescript
const poll = async () => {
  const result = await connection.getSignatureStatus(signature);
  const status = result.value;

  if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
    this.formo.transaction({ status: 'confirmed', ... });
  } else if (status?.err) {
    this.formo.transaction({ status: 'reverted', ... });
  } else {
    setTimeout(poll, 2000); // Retry
  }
};
```

### Memory Management

- **Processed Signatures Set**: Limited to 1000 entries with automatic pruning
- **Pending Transactions Map**: Cleaned up after confirmation
- **Event Listeners**: Properly removed on cleanup

## Limitations

1. **No Built-in Cluster Detection**: You must specify the cluster; it's not auto-detected
2. **No Program Decoding**: Unlike EVM, function names/args aren't extracted from Solana instructions
3. **Single Wallet at a Time**: Tracks one wallet context/adapter at a time
4. **Polling-Based Confirmation**: Uses polling, not websockets, for transaction confirmation

## Troubleshooting

### Events Not Being Tracked

**Check 1**: Ensure wallet is provided
```typescript
// ❌ Bad - no wallet
solana: { cluster: 'mainnet-beta' }

// ✅ Good
solana: { wallet: useWallet(), cluster: 'mainnet-beta' }
```

**Check 2**: Update wallet when it changes (React)
```typescript
useEffect(() => {
  formo?.setSolanaWallet(wallet);
}, [wallet]);
```

**Check 3**: Check autocapture settings
```typescript
autocapture: {
  connect: true,
  signature: true,
  transaction: true,
}
```

### No Transaction Confirmations

Ensure connection is provided:
```typescript
solana: {
  wallet: wallet,
  connection: connection, // Required for confirmations
}
```

### Address Validation Failing

Solana addresses must be:
- 32-44 characters long
- Valid Base58 (no 0, O, I, l characters)
- Case-sensitive

## Testing

### Unit Testing

Mock the wallet adapter:

```typescript
const mockWallet = {
  name: 'Mock Wallet',
  publicKey: {
    toBase58: () => 'FDKJvWcJNe6wecbgDYDFPCfgs14aJnVsUfWQRYWLn4Tn',
  },
  connected: true,
  connecting: false,
  connect: async () => {},
  disconnect: async () => {},
  signMessage: async (message) => new Uint8Array(64),
  sendTransaction: async (tx, conn) => 'mock_signature',
  on: jest.fn(),
  off: jest.fn(),
};
```

## Future Enhancements

Potential improvements for future versions:

1. **Program Instruction Decoding**: Extract program/method names from Solana instructions
2. **WebSocket Confirmation**: Use Solana WebSockets for real-time confirmation
3. **Multi-Wallet Tracking**: Track multiple wallets simultaneously
4. **Auto Cluster Detection**: Detect cluster from connection endpoint
5. **NFT Metadata**: Extract NFT information from transactions

## Resources

- [Solana Wallet Adapter](https://github.com/anza-xyz/wallet-adapter)
- [Solana Web3.js](https://solana-labs.github.io/solana-web3.js/)
- [Solana Documentation](https://solana.com/docs)
- [Formo Analytics Documentation](https://docs.formo.so)

## Support

For issues or questions:
- Open an issue on [GitHub](https://github.com/getformo/sdk)
- Check [Developer Docs](https://docs.formo.so)
