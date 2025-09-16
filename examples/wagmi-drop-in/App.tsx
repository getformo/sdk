import React from 'react';
import { WagmiProvider, createConfig, http } from 'wagmi';
import { mainnet, sepolia } from 'wagmi/chains';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { metaMask, walletConnect, coinbaseWallet } from 'wagmi/connectors';
import { WagmiFormoProvider } from '@formo/analytics/wagmi';
import WalletDemo from './WalletDemo';

// Configure Wagmi
const config = createConfig({
  chains: [mainnet, sepolia],
  connectors: [
    metaMask(),
    walletConnect({ projectId: 'your-project-id' }),
    coinbaseWallet({ appName: 'Formo Drop-in Demo' }),
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
        {/* 
          Drop-in replacement approach:
          1. Use WagmiFormoProvider (single provider)
          2. Import hooks from '@formo/analytics/wagmi' instead of 'wagmi'
          3. Everything else stays exactly the same!
        */}
        <WagmiFormoProvider 
          writeKey="your-formo-write-key"
          options={{
            logger: {
              enabled: true,
              levels: ['info', 'warn', 'error']
            }
          }}
        >
          <div className="app">
            <header>
              <h1>Drop-in Replacement Demo</h1>
              <p>
                This demo shows how to add Formo Analytics to an existing Wagmi app
                with <strong>minimal changes</strong> - just change your imports!
              </p>
              <div className="migration-info">
                <h3>Migration Steps:</h3>
                <ol>
                  <li>Replace <code>FormoAnalyticsProvider</code> with <code>WagmiFormoProvider</code></li>
                  <li>Change hook imports from <code>'wagmi'</code> to <code>'@formo/analytics/wagmi'</code></li>
                  <li>That's it! Everything else stays the same.</li>
                </ol>
              </div>
            </header>
            <main>
              <WalletDemo />
            </main>
          </div>
        </WagmiFormoProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

export default App;
