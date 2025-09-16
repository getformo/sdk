import React from 'react';
import { 
  useAccount, 
  useConnect, 
  useDisconnect, 
  useChainId,
  useSwitchChain,
  useBalance
} from 'wagmi';
import { 
  useSignMessage, 
  useSendTransaction 
} from '@formo/analytics/wagmi';
import { parseEther, formatEther } from 'viem';

function WalletDemo() {
  const { address, isConnected, connector } = useAccount();
  const { connectors, connect, isPending: isConnecting } = useConnect();
  const { disconnect } = useDisconnect();
  const chainId = useChainId();
  const { switchChain, chains } = useSwitchChain();
  const { data: balance } = useBalance({ address });
  
  // Drop-in replacement hooks with automatic Formo tracking
  const { 
    signMessage, 
    isPending: isSigningPending, 
    error: signError 
  } = useSignMessage();
  
  const { 
    sendTransaction, 
    isPending: isSendingPending, 
    error: sendError 
  } = useSendTransaction();

  const handleSignMessage = () => {
    signMessage({ 
      message: `Hello from Enhanced Formo + Wagmi!\nTimestamp: ${Date.now()}` 
    });
  };

  const handleSendTransaction = () => {
    if (!address) return;
    
    sendTransaction({
      to: address, // Send to self for demo
      value: parseEther('0.001'),
    });
  };

  const handleSwitchChain = (targetChainId: number) => {
    switchChain({ chainId: targetChainId });
  };

  if (!isConnected) {
    return (
      <div className="wallet-demo">
        <div className="connect-section">
          <h2>Connect Your Wallet</h2>
          <p>Choose a wallet to connect. Events are automatically tracked by the enhanced provider:</p>
          
          <div className="connectors">
            {connectors.map((connector) => (
              <button
                key={connector.id}
                onClick={() => connect({ connector })}
                disabled={isConnecting}
                className="connector-button"
              >
                {isConnecting ? 'Connecting...' : `Connect ${connector.name}`}
              </button>
            ))}
          </div>
          
          <div className="integration-info">
            <h3>Enhanced Integration Features:</h3>
            <ul>
              <li>✅ <strong>Single Provider</strong> - No need for separate WagmiFormoProvider</li>
              <li>✅ <strong>Automatic Detection</strong> - Detects Wagmi context automatically</li>
              <li>✅ <strong>Flexible Layout</strong> - Works with Wagmi outside Formo provider</li>
              <li>✅ <strong>Zero Config</strong> - Just wrap with FormoAnalyticsProviderWithWagmi</li>
            </ul>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="wallet-demo">
      <div className="wallet-info">
        <h2>Wallet Connected</h2>
        <div className="info-grid">
          <div className="info-item">
            <label>Address:</label>
            <code>{address}</code>
          </div>
          <div className="info-item">
            <label>Connector:</label>
            <span>{connector?.name}</span>
          </div>
          <div className="info-item">
            <label>Chain ID:</label>
            <span>{chainId}</span>
          </div>
          <div className="info-item">
            <label>Balance:</label>
            <span>
              {balance ? `${formatEther(balance.value)} ${balance.symbol}` : 'Loading...'}
            </span>
          </div>
        </div>
        
        <button onClick={() => disconnect()} className="disconnect-button">
          Disconnect Wallet
        </button>
      </div>

      <div className="actions-section">
        <h3>Test Wallet Actions</h3>
        <p>All actions automatically emit events via the enhanced provider:</p>
        
        <div className="action-group">
          <h4>Chain Switching</h4>
          <div className="chain-buttons">
            {chains.map((chain) => (
              <button
                key={chain.id}
                onClick={() => handleSwitchChain(chain.id)}
                disabled={chainId === chain.id}
                className={`chain-button ${chainId === chain.id ? 'active' : ''}`}
              >
                {chain.name} {chainId === chain.id && '(Current)'}
              </button>
            ))}
          </div>
        </div>

        <div className="action-group">
          <h4>Message Signing</h4>
          <button
            onClick={handleSignMessage}
            disabled={isSigningPending}
            className="action-button"
          >
            {isSigningPending ? 'Signing...' : 'Sign Message'}
          </button>
          {signError && (
            <div className="error">
              Sign Error: {signError.message}
            </div>
          )}
        </div>

        <div className="action-group">
          <h4>Send Transaction</h4>
          <button
            onClick={handleSendTransaction}
            disabled={isSendingPending}
            className="action-button"
          >
            {isSendingPending ? 'Sending...' : 'Send 0.001 ETH to Self'}
          </button>
          {sendError && (
            <div className="error">
              Transaction Error: {sendError.message}
            </div>
          )}
        </div>
      </div>

      <div className="enhanced-features">
        <h3>Enhanced Provider Benefits</h3>
        <div className="feature-grid">
          <div className="feature-item">
            <h4>🎯 Single Provider</h4>
            <p>Replaces both FormoAnalyticsProvider + WagmiFormoProvider</p>
          </div>
          <div className="feature-item">
            <h4>🔍 Auto-Detection</h4>
            <p>Automatically detects Wagmi context and enables integration</p>
          </div>
          <div className="feature-item">
            <h4>📐 Flexible Layout</h4>
            <p>Works with WagmiProvider outside or inside</p>
          </div>
          <div className="feature-item">
            <h4>⚙️ Zero Config</h4>
            <p>No additional setup needed beyond the provider</p>
          </div>
        </div>
      </div>

      <div className="events-info">
        <h3>Events Being Tracked</h3>
        <div className="event-list">
          <div className="event-item">
            <strong>connect</strong> - When wallet connects (source: wagmi-auto)
          </div>
          <div className="event-item">
            <strong>disconnect</strong> - When wallet disconnects (source: wagmi-auto)
          </div>
          <div className="event-item">
            <strong>chain</strong> - When network changes (source: wagmi-auto)
          </div>
          <div className="event-item">
            <strong>identify</strong> - Wallet identification (source: wagmi-auto)
          </div>
          <div className="event-item">
            <strong>signature</strong> - Message signing (source: wagmi)
          </div>
          <div className="event-item">
            <strong>transaction</strong> - Transactions (source: wagmi)
          </div>
        </div>
        
        <p className="note">
          <strong>Note:</strong> Events from the enhanced provider are marked with 
          <code>source: "wagmi-auto"</code> to distinguish them from manual tracking.
        </p>
      </div>
    </div>
  );
}

export default WalletDemo;
