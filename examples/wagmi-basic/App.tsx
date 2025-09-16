import React from 'react';
import { WagmiProvider, createConfig, http } from 'wagmi';
import { mainnet, sepolia } from 'wagmi/chains';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { metaMask, walletConnect, coinbaseWallet } from 'wagmi/connectors';
import { FormoAnalyticsProvider } from '@formo/analytics';
import { WagmiFormoProvider } from '@formo/analytics/wagmi';
import WalletDemo from './WalletDemo';

// Configure Wagmi
const config = createConfig({
  chains: [mainnet, sepolia],
  connectors: [
    metaMask(),
    walletConnect({ projectId: 'your-project-id' }),
    coinbaseWallet({ appName: 'Formo Demo' }),
  ],
  transports: {
    [mainnet.id]: http(),
    [sepolia.id]: http(),
  },
});

// Create React Query client
const queryClient = new QueryClient();

function App() {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <FormoAnalyticsProvider 
          writeKey="your-formo-write-key"
          options={{
            logger: {
              enabled: true,
              levels: ['info', 'warn', 'error']
            }
          }}
        >
          <WagmiFormoProvider enableAutoTracking={true}>
            <div className="app">
              <header>
                <h1>Formo + Wagmi Integration Demo</h1>
                <p>
                  This demo shows automatic wallet event tracking with Formo Analytics and Wagmi.
                  All wallet connections, disconnections, chain changes, transactions, and signatures
                  are automatically tracked.
                </p>
              </header>
              <main>
                <WalletDemo />
              </main>
            </div>
          </WagmiFormoProvider>
        </FormoAnalyticsProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

export default App;
