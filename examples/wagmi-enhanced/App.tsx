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
    coinbaseWallet({ appName: 'Formo Enhanced Demo' }),
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
          Unified approach: Single provider that combines both!
          WagmiFormoProvider automatically detects Wagmi context
          and enables wallet event tracking
        */}
        <WagmiFormoProvider 
          writeKey="your-formo-write-key"
          enableWagmiIntegration={true}
          wagmiDebounceMs={100}
          options={{
            logger: {
              enabled: true,
              levels: ['info', 'warn', 'error']
            }
          }}
        >
          <div className="app">
            <header>
              <h1>Unified Formo + Wagmi Integration</h1>
              <p>
                This demo uses the unified <code>WagmiFormoProvider</code> provider
                that automatically detects and integrates with Wagmi context.
              </p>
              <div className="layout-info">
                <h3>Layout Structure:</h3>
                <pre>{`
<WagmiProvider>
  <WagmiFormoProvider>
    <App />
  </WagmiFormoProvider>
</WagmiProvider>
                `}</pre>
                <p>✅ Single provider handles both Formo Analytics and Wagmi integration!</p>
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
