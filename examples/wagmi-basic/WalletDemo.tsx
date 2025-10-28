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
  useSendTransaction,
  useFormoWallet 
} from '@formo/analytics/wagmi';
import { parseEther, formatEther } from 'viem';
import { mainnet, sepolia } from 'wagmi/chains';

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
      message: `Hello from Formo + Wagmi demo!\nTimestamp: ${Date.now()}` 
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
          <p>Choose a wallet to connect and start tracking events with Formo Analytics:</p>
          
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
          
          <div className="info-box">
            <h3>What gets tracked automatically:</h3>
            <ul>
              <li>✅ Wallet connection events</li>
              <li>✅ Wallet disconnection events</li>
              <li>✅ Network/chain change events</li>
              <li>✅ Wallet identification</li>
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
        <p>These actions will automatically emit events to Formo Analytics:</p>
        
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

      <div className="events-info">
        <h3>Events Being Tracked</h3>
        <div className="event-list">
          <div className="event-item">
            <strong>connect</strong> - When wallet connects
          </div>
          <div className="event-item">
            <strong>disconnect</strong> - When wallet disconnects
          </div>
          <div className="event-item">
            <strong>chain</strong> - When network changes
          </div>
          <div className="event-item">
            <strong>identify</strong> - Wallet identification
          </div>
          <div className="event-item">
            <strong>signature</strong> - Message signing (requested/confirmed/rejected)
          </div>
          <div className="event-item">
            <strong>transaction</strong> - Transactions (started/broadcasted/rejected)
          </div>
        </div>
        
        <p className="note">
          <strong>Note:</strong> Check your browser's developer console to see 
          Formo Analytics logs and events being emitted in real-time.
        </p>
      </div>
    </div>
  );
}

export default WalletDemo;
