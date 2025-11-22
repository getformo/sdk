# Wagmi Integration Setup Guide for Next.js

This guide walks you through setting up Formo Analytics with Wagmi integration in a Next.js application.

## Prerequisites

- Next.js 13+ (with App Router or Pages Router)
- React 18+
- Node.js 16+

## Installation

### Step 1: Install Required Packages

```bash
npm install @formo/analytics wagmi @tanstack/react-query viem
```

Or with yarn:

```bash
yarn add @formo/analytics wagmi @tanstack/react-query viem
```

Or with pnpm:

```bash
pnpm add @formo/analytics wagmi @tanstack/react-query viem
```

### Package Overview

- **@formo/analytics**: The Formo Analytics SDK
- **wagmi**: React hooks for Ethereum (v2.0.0+)
- **@tanstack/react-query**: Required for Wagmi and mutation tracking (v5.0.0+)
- **viem**: TypeScript library for Ethereum (peer dependency of Wagmi)

## Setup for Next.js App Router (13+)

### Step 2: Create Wagmi Configuration

Create a new file for your Wagmi configuration:

**`src/config/wagmi.ts`**

```typescript
import { http, createConfig } from 'wagmi';
import { mainnet, polygon, arbitrum, optimism } from 'wagmi/chains';
import { injected, walletConnect, coinbaseWallet } from 'wagmi/connectors';

// Get your WalletConnect project ID from https://cloud.walletconnect.com
const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || '';

export const wagmiConfig = createConfig({
  chains: [mainnet, polygon, arbitrum, optimism],
  connectors: [
    injected(),
    walletConnect({ projectId }),
    coinbaseWallet({ appName: 'Your App Name' }),
  ],
  transports: {
    [mainnet.id]: http(),
    [polygon.id]: http(),
    [arbitrum.id]: http(),
    [optimism.id]: http(),
  },
  ssr: true, // Enable server-side rendering support
});
```

### Step 3: Create Providers Component

Create a client component that wraps your app with all necessary providers:

**`src/components/providers.tsx`**

```typescript
'use client';

import { ReactNode, useState } from 'react';
import { WagmiProvider } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FormoAnalyticsProvider } from '@formo/analytics';
import { wagmiConfig } from '@/config/wagmi';

export function Providers({ children }: { children: ReactNode }) {
  // Initialize QueryClient - must be inside component to work with React Server Components
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Avoid refetching too often in SSR
            staleTime: 60 * 1000,
          },
        },
      })
  );

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <FormoAnalyticsProvider
          writeKey={process.env.NEXT_PUBLIC_FORMO_WRITE_KEY || ''}
          options={{
            wagmi: {
              config: wagmiConfig,
              queryClient: queryClient, // ⚠️ IMPORTANT: Provide QueryClient for full tracking
            },
            autocapture: {
              connect: true,
              disconnect: true,
              chain: true,
              signature: true,
              transaction: true,
            },
            logger: {
              enabled: process.env.NODE_ENV === 'development',
              levels: ['info', 'warn', 'error'],
            },
          }}
        >
          {children}
        </FormoAnalyticsProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
```

#### ⚠️ Important: QueryClient is Required for Full Tracking

**Always provide the QueryClient** to track all event types. Here's what gets tracked:

| Event Type | Without QueryClient | With QueryClient |
|-----------|-------------------|------------------|
| Connect | ✅ Tracked | ✅ Tracked |
| Disconnect | ✅ Tracked | ✅ Tracked |
| Chain Change | ✅ Tracked | ✅ Tracked |
| Signatures | ❌ NOT Tracked | ✅ Tracked |
| Transactions | ❌ NOT Tracked | ✅ Tracked |

**Why is this important?**
- Wagmi hooks like `useSignMessage` and `useSendTransaction` use TanStack Query mutations internally
- The only way to track these is through the QueryClient's mutation cache
- Since TanStack Query is already installed (it's required by Wagmi), always pass the QueryClient

```typescript
// ❌ BAD: Missing QueryClient - signatures/transactions won't be tracked
wagmi: {
  config: wagmiConfig,
}

// ✅ GOOD: Full tracking enabled
wagmi: {
  config: wagmiConfig,
  queryClient: queryClient,
}
```

### Step 4: Update Root Layout

Wrap your app with the Providers component:

**`src/app/layout.tsx`**

```typescript
import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { Providers } from '@/components/providers';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Your App',
  description: 'Your app description',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
```

### Step 5: Configure Environment Variables

Create or update your `.env.local` file:

```bash
# Formo Analytics Write Key
NEXT_PUBLIC_FORMO_WRITE_KEY=your_write_key_here

# WalletConnect Project ID (optional, for WalletConnect connector)
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=your_walletconnect_project_id
```

**Important**: Add `.env.local` to your `.gitignore` to avoid committing secrets.

### Step 6: Use Wagmi Hooks in Components

Now you can use Wagmi hooks in your client components, and Formo will automatically track all wallet events:

**`src/components/connect-button.tsx`**

```typescript
'use client';

import { useAccount, useConnect, useDisconnect } from 'wagmi';

export function ConnectButton() {
  const { address, isConnected } = useAccount();
  const { connectors, connect } = useConnect();
  const { disconnect } = useDisconnect();

  if (isConnected) {
    return (
      <div className="flex items-center gap-4">
        <p>Connected: {address}</p>
        <button onClick={() => disconnect()}>Disconnect</button>
      </div>
    );
  }

  return (
    <div className="flex gap-2">
      {connectors.map((connector) => (
        <button
          key={connector.id}
          onClick={() => connect({ connector })}
          disabled={!connector.ready}
        >
          Connect {connector.name}
        </button>
      ))}
    </div>
  );
}
```

**`src/components/sign-message.tsx`**

```typescript
'use client';

import { useSignMessage } from 'wagmi';

export function SignMessage() {
  const { data, signMessage, isPending, isError, error } = useSignMessage();

  return (
    <div>
      <button
        onClick={() => signMessage({ message: 'Hello from Formo!' })}
        disabled={isPending}
      >
        {isPending ? 'Signing...' : 'Sign Message'}
      </button>
      
      {data && <p>Signature: {data}</p>}
      {isError && <p>Error: {error?.message}</p>}
    </div>
  );
}
```

## Setup for Next.js Pages Router

### Step 2: Create Wagmi Configuration

Same as App Router - create `src/config/wagmi.ts` as shown above.

### Step 3: Update _app.tsx

Wrap your app with the providers in `_app.tsx`:

**`src/pages/_app.tsx`**

```typescript
import '@/styles/globals.css';
import type { AppProps } from 'next/app';
import { WagmiProvider } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FormoAnalyticsProvider } from '@formo/analytics';
import { wagmiConfig } from '@/config/wagmi';
import { useState } from 'react';

export default function App({ Component, pageProps }: AppProps) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <FormoAnalyticsProvider
          writeKey={process.env.NEXT_PUBLIC_FORMO_WRITE_KEY || ''}
          options={{
            wagmi: {
              config: wagmiConfig,
              queryClient: queryClient,
            },
            autocapture: {
              connect: true,
              disconnect: true,
              chain: true,
              signature: true,
              transaction: true,
            },
          }}
        >
          <Component {...pageProps} />
        </FormoAnalyticsProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
```

### Step 4: Configure Environment Variables

Same as App Router - create `.env.local` as shown above.

## Advanced Configuration

### Custom RPC Endpoints

For better performance and reliability, use custom RPC endpoints:

**`src/config/wagmi.ts`**

```typescript
import { http, createConfig } from 'wagmi';
import { mainnet, polygon } from 'wagmi/chains';

export const wagmiConfig = createConfig({
  chains: [mainnet, polygon],
  transports: {
    [mainnet.id]: http(process.env.NEXT_PUBLIC_MAINNET_RPC_URL),
    [polygon.id]: http(process.env.NEXT_PUBLIC_POLYGON_RPC_URL),
  },
  ssr: true,
});
```

### Conditional Event Tracking

Track events only in production:

```typescript
<FormoAnalyticsProvider
  writeKey={process.env.NEXT_PUBLIC_FORMO_WRITE_KEY || ''}
  options={{
    wagmi: {
      config: wagmiConfig,
      queryClient: queryClient,
    },
    autocapture: process.env.NODE_ENV === 'production' ? {
      connect: true,
      disconnect: true,
      chain: true,
      signature: true,
      transaction: true,
    } : false, // Disable in development
  }}
/>
```

### API Host Configuration

Point to a different API host (e.g., EU region):

```typescript
<FormoAnalyticsProvider
  writeKey={process.env.NEXT_PUBLIC_FORMO_WRITE_KEY || ''}
  options={{
    wagmi: {
      config: wagmiConfig,
      queryClient: queryClient,
    },
    apiHost: 'https://eu-api.formo.so', // Custom API endpoint
  }}
/>
```

### Tracking Only Specific Events

Track only connections and signatures, skip transactions:

```typescript
<FormoAnalyticsProvider
  writeKey={process.env.NEXT_PUBLIC_FORMO_WRITE_KEY || ''}
  options={{
    wagmi: {
      config: wagmiConfig,
      queryClient: queryClient,
    },
    autocapture: {
      connect: true,
      disconnect: true,
      chain: false,
      signature: true,
      transaction: false, // Don't track transactions
    },
  }}
/>
```

## Using Formo SDK Methods

Access the Formo SDK instance using the `useFormo` hook:

**`src/components/manual-tracking.tsx`**

```typescript
'use client';

import { useFormo } from '@formo/analytics';
import { useAccount } from 'wagmi';

export function ManualTracking() {
  const formo = useFormo();
  const { address } = useAccount();

  const trackCustomEvent = async () => {
    await formo.track('custom_button_clicked', {
      button_name: 'Hero CTA',
      page: 'landing',
    });
  };

  const identifyUser = async () => {
    if (address) {
      await formo.identify({
        address,
        userId: 'user_123', // Your internal user ID
        providerName: 'MetaMask',
      });
    }
  };

  return (
    <div>
      <button onClick={trackCustomEvent}>
        Track Custom Event
      </button>
      <button onClick={identifyUser}>
        Identify User
      </button>
    </div>
  );
}
```

## Server-Side Rendering (SSR) Considerations

### Hydration Issues

Wagmi is designed to work with SSR, but wallet connections only happen client-side. Make sure to:

1. Set `ssr: true` in your Wagmi config
2. Use `'use client'` directive for components using Wagmi hooks
3. Handle loading states properly

**Example:**

```typescript
'use client';

import { useAccount } from 'wagmi';
import { useEffect, useState } from 'react';

export function UserProfile() {
  const { address } = useAccount();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return <div>Loading...</div>;
  }

  return <div>{address ? `Connected: ${address}` : 'Not connected'}</div>;
}
```

### Avoiding Hydration Mismatch

Wrap wallet-dependent content in a client-only component:

**`src/components/client-only.tsx`**

```typescript
'use client';

import { useEffect, useState, ReactNode } from 'react';

export function ClientOnly({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  return mounted ? <>{children}</> : null;
}
```

**Usage:**

```typescript
import { ClientOnly } from '@/components/client-only';
import { ConnectButton } from '@/components/connect-button';

export default function Page() {
  return (
    <div>
      <h1>My App</h1>
      <ClientOnly>
        <ConnectButton />
      </ClientOnly>
    </div>
  );
}
```

## Testing

### Development Mode

Test your integration locally:

1. Start your Next.js dev server:
```bash
npm run dev
```

2. Open browser console and enable verbose logging:
```typescript
// In your providers component
logger: {
  enabled: true,
  levels: ['info', 'warn', 'error', 'debug'],
}
```

3. Connect your wallet and perform actions
4. Check console for Formo Analytics events

### Testing Events

Create a test page to verify all event types:

**`src/app/test/page.tsx`**

```typescript
'use client';

import { useAccount, useConnect, useDisconnect, useSignMessage, useSendTransaction, useSwitchChain } from 'wagmi';
import { parseEther } from 'viem';

export default function TestPage() {
  const { address, isConnected, chain } = useAccount();
  const { connectors, connect } = useConnect();
  const { disconnect } = useDisconnect();
  const { signMessage } = useSignMessage();
  const { sendTransaction } = useSendTransaction();
  const { switchChain } = useSwitchChain();

  return (
    <div className="p-8 space-y-4">
      <h1 className="text-2xl font-bold">Formo Analytics Test Page</h1>
      
      <div className="space-y-2">
        <h2 className="font-semibold">Connection Test</h2>
        {!isConnected ? (
          connectors.map((connector) => (
            <button
              key={connector.id}
              onClick={() => connect({ connector })}
              className="px-4 py-2 bg-blue-500 text-white rounded"
            >
              Connect {connector.name}
            </button>
          ))
        ) : (
          <button
            onClick={() => disconnect()}
            className="px-4 py-2 bg-red-500 text-white rounded"
          >
            Disconnect
          </button>
        )}
      </div>

      {isConnected && (
        <>
          <div className="space-y-2">
            <h2 className="font-semibold">Chain Switch Test</h2>
            <button
              onClick={() => switchChain({ chainId: 1 })}
              className="px-4 py-2 bg-purple-500 text-white rounded"
            >
              Switch to Ethereum
            </button>
            <button
              onClick={() => switchChain({ chainId: 137 })}
              className="px-4 py-2 bg-purple-500 text-white rounded"
            >
              Switch to Polygon
            </button>
          </div>

          <div className="space-y-2">
            <h2 className="font-semibold">Signature Test</h2>
            <button
              onClick={() => signMessage({ message: 'Hello Formo!' })}
              className="px-4 py-2 bg-green-500 text-white rounded"
            >
              Sign Message
            </button>
          </div>

          <div className="space-y-2">
            <h2 className="font-semibold">Transaction Test (Testnet only!)</h2>
            <button
              onClick={() =>
                sendTransaction({
                  to: address,
                  value: parseEther('0.001'),
                })
              }
              className="px-4 py-2 bg-orange-500 text-white rounded"
            >
              Send Transaction
            </button>
          </div>
        </>
      )}
    </div>
  );
}
```

## Troubleshooting

### Events Not Appearing in Dashboard

1. **Check your write key**: Ensure `NEXT_PUBLIC_FORMO_WRITE_KEY` is set correctly
2. **Verify network requests**: Open Network tab in DevTools and look for requests to Formo API
3. **Enable logging**: Set `logger.enabled: true` in options
4. **Check autocapture settings**: Make sure events you want are not disabled

### QueryClient Not Provided Warning

If you see: `WagmiEventHandler: QueryClient not provided. Signature and transaction events will not be tracked via Wagmi.`

**This means signatures and transactions won't be tracked!**

Make sure you're passing the QueryClient to Formo:

```typescript
// ❌ BAD - signatures/transactions not tracked
wagmi: {
  config: wagmiConfig,
}

// ✅ GOOD - full tracking enabled
wagmi: {
  config: wagmiConfig,
  queryClient: queryClient, // Same instance used in QueryClientProvider
}
```

**What gets tracked without QueryClient:**
- ✅ Wallet connections
- ✅ Wallet disconnections  
- ✅ Chain/network changes
- ❌ Message signatures
- ❌ Transactions

**Solution**: Always provide the QueryClient since you already have it installed (it's required by Wagmi).

### Multiple Providers / EIP-6963

**Question**: How does Wagmi mode handle multiple wallet providers (EIP-6963)?

**Answer**: In Wagmi mode, **EIP-6963 detection is completely bypassed**. Wagmi has its own connector system that handles multiple wallets, so we don't need EIP-6963:

- **Non-Wagmi Mode**: Uses EIP-6963 to discover and track multiple wallet providers
- **Wagmi Mode**: Uses Wagmi's connector system (injected, WalletConnect, Coinbase Wallet, etc.)

When you enable Wagmi mode, the SDK:
1. ✅ Tracks events through Wagmi's connector state changes
2. ❌ Skips EIP-1193 provider wrapping
3. ❌ Skips EIP-6963 provider discovery

This is intentional - Wagmi provides a better abstraction for handling multiple wallets through its connector architecture.

### Hydration Errors

If you see hydration mismatch errors:

1. Wrap wallet components in `ClientOnly`
2. Use `useEffect` to set mounted state
3. Ensure `ssr: true` in Wagmi config

### Type Errors

If you get TypeScript errors with Wagmi/Viem:

```bash
npm install --save-dev @wagmi/core @wagmi/connectors viem@latest
```

### Build Errors in Production

If build fails with "Module not found" for Wagmi:

Make sure you're using Next.js 13+ and have correct `"use client"` directives:

```typescript
'use client'; // Must be at the top of files using Wagmi hooks

import { useAccount } from 'wagmi';
```

## Production Checklist

Before deploying to production:

- [ ] Set `NEXT_PUBLIC_FORMO_WRITE_KEY` in your hosting platform's environment variables
- [ ] Disable verbose logging in production (`logger.enabled: false`)
- [ ] Test all wallet connectors (MetaMask, WalletConnect, Coinbase Wallet)
- [ ] Verify events appear in Formo Analytics dashboard
- [ ] Set up custom RPC endpoints (optional but recommended)
- [ ] Test on multiple chains if multi-chain
- [ ] Verify SSR/hydration works correctly
- [ ] Add error boundaries around wallet components

## Example Projects

### Minimal Setup

See our example project for a minimal working setup:
- [Next.js + Wagmi + Formo Example](https://github.com/getformo/examples/tree/main/nextjs-wagmi)

### Full-Featured

For a more comprehensive example with authentication and multi-chain:
- [Complete Web3 App Example](https://github.com/getformo/examples/tree/main/complete-web3-app)

## Next Steps

Now that you have Formo Analytics set up with Wagmi:

1. **View Analytics**: Log in to [Formo Dashboard](https://app.formo.so) to see your events
2. **Set Up Segments**: Create user segments based on wallet behavior
3. **Configure Alerts**: Get notified of important user actions
4. **Export Data**: Connect to your data warehouse for deeper analysis

## Support

Need help?

- 📖 [Full Documentation](https://docs.formo.so)
- 💬 [Community Discord](https://formo.so/discord)
- 📧 [Email Support](mailto:support@formo.so)
- 🐛 [Report Issues](https://github.com/getformo/sdk/issues)

## Additional Resources

- [Wagmi Documentation](https://wagmi.sh)
- [TanStack Query Documentation](https://tanstack.com/query)
- [Next.js Documentation](https://nextjs.org/docs)
- [Viem Documentation](https://viem.sh)

