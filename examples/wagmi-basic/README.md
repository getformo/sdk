# Formo + Wagmi Basic Example

This example demonstrates the basic integration between Formo Analytics and Wagmi for automatic wallet event tracking.

## Features Demonstrated

- ✅ Automatic wallet connection/disconnection tracking
- ✅ Chain switching events
- ✅ Message signing with event tracking
- ✅ Transaction sending with event tracking
- ✅ Wallet identification
- ✅ Multiple connector support (MetaMask, WalletConnect, Coinbase Wallet)

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure your Formo write key:**
   
   Edit `App.tsx` and replace `"your-formo-write-key"` with your actual Formo Analytics write key:
   ```tsx
   <FormoAnalyticsProvider writeKey="your-actual-write-key">
   ```

3. **Configure WalletConnect (optional):**
   
   If you want to test WalletConnect, replace `"your-project-id"` in `App.tsx` with your WalletConnect project ID:
   ```tsx
   walletConnect({ projectId: 'your-actual-project-id' })
   ```

4. **Start the development server:**
   ```bash
   npm run dev
   ```

## What You'll See

1. **Connection Flow:**
   - Choose a wallet connector (MetaMask, WalletConnect, etc.)
   - Connect your wallet
   - See automatic `connect` and `identify` events in the console

2. **Wallet Actions:**
   - Switch between networks (Mainnet ↔ Sepolia)
   - Sign messages
   - Send transactions (to yourself for testing)
   - All actions automatically emit Formo events

3. **Disconnection:**
   - Disconnect your wallet
   - See automatic `disconnect` event

## Event Tracking

The following events are automatically tracked:

| Event Type | When It's Emitted | Data Included |
|------------|-------------------|---------------|
| `connect` | Wallet connects | address, chainId, connector info |
| `disconnect` | Wallet disconnects | address, chainId |
| `chain` | Network changes | new chainId, address |
| `identify` | Wallet identified | address, provider name, RDNS |
| `signature` | Message signing | status (requested/confirmed/rejected), message |
| `transaction` | Transaction sent | status (started/broadcasted/rejected), tx details |

## Console Logging

The example enables Formo's built-in logging so you can see events in real-time:

```tsx
<FormoAnalyticsProvider 
  writeKey="your-key"
  options={{
    logger: {
      enabled: true,
      levels: ['info', 'warn', 'error']
    }
  }}
>
```

Open your browser's developer console to see the events being emitted.

## Code Structure

- `App.tsx` - Main app setup with providers
- `WalletDemo.tsx` - Demo component showing wallet interactions
- Uses enhanced hooks: `useFormoSignMessage`, `useFormoSendTransaction`

## Key Integration Points

### 1. Provider Setup
```tsx
<WagmiProvider config={config}>
  <QueryClientProvider client={queryClient}>
    <FormoAnalyticsProvider writeKey="...">
      <WagmiFormoProvider>
        <App />
      </WagmiFormoProvider>
    </FormoAnalyticsProvider>
  </QueryClientProvider>
</WagmiProvider>
```

### 2. Enhanced Hooks
```tsx
// Instead of useSignMessage
const { signMessage } = useFormoSignMessage();

// Instead of useSendTransaction  
const { sendTransaction } = useFormoSendTransaction();
```

### 3. Automatic Tracking
No additional code needed! The `WagmiFormoProvider` automatically tracks:
- Wallet connections/disconnections
- Chain changes
- Address changes

## Customization

You can customize the integration behavior:

```tsx
<WagmiFormoProvider 
  enableAutoTracking={true}
  debounceMs={100}
>
  <App />
</WagmiFormoProvider>
```

## Next Steps

- Try the [Advanced Example](../wagmi-advanced) for more complex scenarios
- Check out the [Next.js Example](../nextjs-wagmi) for a full-stack setup
- Read the [Wagmi Integration Documentation](../../docs/WAGMI_INTEGRATION.md)
