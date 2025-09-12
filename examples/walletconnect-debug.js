/**
 * WalletConnect Debug Helper
 * 
 * This script provides debugging utilities for WalletConnect integration
 * with the Formo Analytics SDK.
 * 
 * Usage:
 * 1. Include this script in your web app
 * 2. Call the debug functions from browser console
 * 3. Monitor console logs for WalletConnect events
 */

// Global debug utilities for WalletConnect
window.FormoWalletConnectDebug = {
  
  /**
   * Check current provider state
   */
  checkProviderState: function() {
    if (!window.formoAnalytics) {
      console.error('Formo Analytics not initialized');
      return;
    }
    
    const state = window.formoAnalytics.getProviderState();
    console.log('Provider State:', state);
    
    // List all providers
    const providers = window.formoAnalytics.providers;
    console.log('All Providers:', providers.map(p => ({
      name: p.info.name,
      rdns: p.info.rdns,
      isWalletConnect: window.formoAnalytics.isWalletConnectProvider?.(p.provider) || 'unknown'
    })));
    
    return state;
  },
  
  /**
   * Manually trigger WalletConnect connection check
   */
  checkWalletConnectConnections: async function() {
    if (!window.formoAnalytics) {
      console.error('Formo Analytics not initialized');
      return;
    }
    
    console.log('Checking WalletConnect connections...');
    
    try {
      await window.formoAnalytics.checkWalletConnectConnections();
      console.log('WalletConnect connection check completed');
    } catch (error) {
      console.error('Error checking WalletConnect connections:', error);
    }
  },
  
  /**
   * Monitor provider events
   */
  monitorProviderEvents: function() {
    if (typeof window.ethereum === 'undefined') {
      console.warn('No ethereum provider found');
      return;
    }
    
    const provider = window.ethereum;
    
    // Monitor standard events
    const events = ['connect', 'disconnect', 'accountsChanged', 'chainChanged'];
    
    events.forEach(eventName => {
      provider.on(eventName, (...args) => {
        console.log(`Provider Event [${eventName}]:`, args);
      });
    });
    
    // Monitor WalletConnect specific events if available
    if (provider.connector) {
      const wcEvents = ['session_update', 'connect', 'disconnect', 'session_request'];
      
      wcEvents.forEach(eventName => {
        if (typeof provider.connector.on === 'function') {
          provider.connector.on(eventName, (...args) => {
            console.log(`WalletConnect Event [${eventName}]:`, args);
          });
        }
      });
    }
    
    console.log('Provider event monitoring started');
  },
  
  /**
   * Test connection with current provider
   */
  testConnection: async function() {
    if (typeof window.ethereum === 'undefined') {
      console.error('No ethereum provider found');
      return;
    }
    
    const provider = window.ethereum;
    
    try {
      console.log('Testing connection...');
      
      // Request accounts
      const accounts = await provider.request({ method: 'eth_accounts' });
      console.log('Accounts:', accounts);
      
      // Get chain ID
      const chainId = await provider.request({ method: 'eth_chainId' });
      console.log('Chain ID:', chainId);
      
      // Check if it's WalletConnect
      const isWC = !!(
        provider.isWalletConnect ||
        provider.connector ||
        provider.bridge ||
        provider.wc
      );
      console.log('Is WalletConnect:', isWC);
      
      if (accounts.length > 0) {
        console.log('✅ Connection successful');
        
        // Trigger Formo Analytics connect event
        if (window.formoAnalytics) {
          await window.formoAnalytics.connect({
            chainId: parseInt(chainId, 16),
            address: accounts[0]
          });
          console.log('✅ Formo Analytics connect event triggered');
        }
      } else {
        console.log('❌ No accounts connected');
      }
      
    } catch (error) {
      console.error('Connection test failed:', error);
    }
  },
  
  /**
   * Enable debug logging
   */
  enableDebugLogging: function() {
    // Enable Formo Analytics debug logging if available
    if (window.formoAnalytics && window.formoAnalytics.options) {
      window.formoAnalytics.options.logger = {
        enabled: true,
        levels: ['info', 'warn', 'error', 'debug']
      };
    }
    
    console.log('Debug logging enabled');
  }
};

// Auto-initialize monitoring if Formo Analytics is available
if (typeof window !== 'undefined') {
  window.addEventListener('load', () => {
    if (window.formoAnalytics) {
      console.log('🔍 Formo WalletConnect Debug utilities loaded');
      console.log('Available functions:');
      console.log('- FormoWalletConnectDebug.checkProviderState()');
      console.log('- FormoWalletConnectDebug.checkWalletConnectConnections()');
      console.log('- FormoWalletConnectDebug.monitorProviderEvents()');
      console.log('- FormoWalletConnectDebug.testConnection()');
      console.log('- FormoWalletConnectDebug.enableDebugLogging()');
    }
  });
}
