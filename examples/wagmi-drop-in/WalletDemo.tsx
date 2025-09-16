import React from 'react';
import { 
  useAccount, 
  useConnect, 
  useDisconnect, 
  useChainId,
  useSwitchChain,
  useBalance
} from 'wagmi';
// 🎯 Key change: Import these hooks from Formo instead of Wagmi
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
  
  // These hooks look identical to Wagmi but automatically track events!
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
      message: `Drop-in replacement demo!\nTimestamp: ${Date.now()}` 
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
          <p>This demo shows how existing Wagmi code works unchanged with Formo tracking:</p>
          
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
          
          <div className="code-comparison">
            <h3>Code Changes Required:</h3>
            <div className="before-after">
              <div className="before">
                <h4>❌ Before (Original Wagmi)</h4>
                <pre>{`import { 
  useSignMessage, 
  useSendTransaction 
} from 'wagmi';`}</pre>
              </div>
              <div className="after">
                <h4>✅ After (With Formo Tracking)</h4>
                <pre>{`import { 
  useSignMessage, 
  useSendTransaction 
} from '@formo/analytics/wagmi';`}</pre>
              </div>
            </div>
            <p><strong>That's it!</strong> Everything else stays exactly the same.</p>
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
        <h3>Test Drop-in Replacement Hooks</h3>
        <p>These hooks have the exact same API as Wagmi but automatically track events:</p>
        
        <div className="action-group">
          <h4>Chain Switching</h4>
          <p><em>Uses original Wagmi hooks (useChainId, useSwitchChain) - automatically tracked by provider</em></p>
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
          <p><em>Uses drop-in replacement: useSignMessage from '@formo/analytics/wagmi'</em></p>
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
          <p><em>Uses drop-in replacement: useSendTransaction from '@formo/analytics/wagmi'</em></p>
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

      <div className="drop-in-benefits">
        <h3>Drop-in Replacement Benefits</h3>
        <div className="benefit-grid">
          <div className="benefit-item">
            <h4>🔄 Zero API Changes</h4>
            <p>Hooks have identical signatures and behavior to original Wagmi hooks</p>
          </div>
          <div className="benefit-item">
            <h4>📦 Minimal Migration</h4>
            <p>Just change import statements - no code refactoring needed</p>
          </div>
          <div className="benefit-item">
            <h4>🎯 Automatic Tracking</h4>
            <p>All signature and transaction events automatically tracked</p>
          </div>
          <div className="benefit-item">
            <h4>🔒 Type Safety</h4>
            <p>Full TypeScript support with identical types</p>
          </div>
        </div>
      </div>

      <div className="events-info">
        <h3>Events Being Tracked</h3>
        <div className="event-list">
          <div className="event-item">
            <strong>connect</strong> - Automatic (from provider)
          </div>
          <div className="event-item">
            <strong>disconnect</strong> - Automatic (from provider)
          </div>
          <div className="event-item">
            <strong>chain</strong> - Automatic (from provider)
          </div>
          <div className="event-item">
            <strong>identify</strong> - Automatic (from provider)
          </div>
          <div className="event-item">
            <strong>signature</strong> - From useSignMessage drop-in replacement
          </div>
          <div className="event-item">
            <strong>transaction</strong> - From useSendTransaction drop-in replacement
          </div>
        </div>
        
        <p className="note">
          <strong>Perfect for existing apps:</strong> Add analytics to your existing 
          Wagmi app by changing just the import statements!
        </p>
      </div>
    </div>
  );
}

export default WalletDemo;
