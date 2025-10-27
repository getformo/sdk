import { FormoAnalytics } from '../src/FormoAnalytics';
import type { EIP1193Provider } from '../src/types';

/**
 * Integration tests for Wallet Autocapture Configuration
 * 
 * These tests verify actual SDK behavior with various autocapture configurations:
 * - Listener registration
 * - Event emission
 * - State management
 */

// Mock provider factory
function createMockProvider(): EIP1193Provider & { _triggerEvent: (event: string, ...args: any[]) => void; _listeners: any } {
  const listeners: { [event: string]: ((...args: any[]) => void)[] } = {};
  
  const mockRequest = jest.fn(async ({ method, params }: any) => {
    if (method === 'eth_accounts') {
      return ['0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb'];
    }
    if (method === 'eth_chainId') {
      return '0x1';
    }
    if (method === 'eth_sendTransaction') {
      return '0x123abc';
    }
    if (method === 'personal_sign') {
      return '0xsignature';
    }
    return null;
  });

  const mockOn = jest.fn((event: string, listener: (...args: any[]) => void) => {
    if (!listeners[event]) listeners[event] = [];
    listeners[event].push(listener);
  });

  const mockRemoveListener = jest.fn((event: string, listener: (...args: any[]) => void) => {
    if (listeners[event]) {
      listeners[event] = listeners[event].filter(l => l !== listener);
    }
  });

  return {
    request: mockRequest,
    on: mockOn,
    removeListener: mockRemoveListener,
    _triggerEvent: (event: string, ...args: any[]) => {
      if (listeners[event]) {
        listeners[event].forEach(listener => listener(...args));
      }
    },
    _listeners: listeners
  } as any;
}

describe('FormoAnalytics - Autocapture Integration Tests', () => {
  let mockProvider: ReturnType<typeof createMockProvider>;

  beforeEach(() => {
    mockProvider = createMockProvider();
    jest.clearAllMocks();
  });

  describe('Default Behavior', () => {
    it('should track all wallet events when no config provided', async () => {
      const analytics = await FormoAnalytics.init('test-key', {});
      
      // Access private method for testing
      const isConnect = (analytics as any).isWalletAutocaptureEnabled('connect');
      const isDisconnect = (analytics as any).isWalletAutocaptureEnabled('disconnect');
      const isSignature = (analytics as any).isWalletAutocaptureEnabled('signature');
      const isTransaction = (analytics as any).isWalletAutocaptureEnabled('transaction');
      const isChain = (analytics as any).isWalletAutocaptureEnabled('chain');

      expect(isConnect).toBe(true);
      expect(isDisconnect).toBe(true);
      expect(isSignature).toBe(true);
      expect(isTransaction).toBe(true);
      expect(isChain).toBe(true);
    });

    it('should register accountsChanged listener with default config', async () => {
      const analytics = await FormoAnalytics.init('test-key', {
        provider: mockProvider
      });

      // Verify accountsChanged listener was registered
      expect(mockProvider.on).toHaveBeenCalledWith('accountsChanged', expect.any(Function));
    });

    it('should register all listeners with default config', async () => {
      const analytics = await FormoAnalytics.init('test-key', {
        provider: mockProvider
      });

      // All listeners should be registered
      expect(mockProvider.on).toHaveBeenCalledWith('accountsChanged', expect.any(Function));
      expect(mockProvider.on).toHaveBeenCalledWith('chainChanged', expect.any(Function));
      expect(mockProvider.on).toHaveBeenCalledWith('connect', expect.any(Function));
      expect(mockProvider.on).toHaveBeenCalledWith('disconnect', expect.any(Function));
    });
  });

  describe('Boolean Configuration', () => {
    it('should disable all event tracking when autocapture is false', async () => {
      const analytics = await FormoAnalytics.init('test-key', {
        autocapture: false
      });

      const isConnect = (analytics as any).isWalletAutocaptureEnabled('connect');
      const isDisconnect = (analytics as any).isWalletAutocaptureEnabled('disconnect');
      const isSignature = (analytics as any).isWalletAutocaptureEnabled('signature');

      expect(isConnect).toBe(false);
      expect(isDisconnect).toBe(false);
      expect(isSignature).toBe(false);
    });

    it('should still register accountsChanged listener when autocapture is false', async () => {
      const analytics = await FormoAnalytics.init('test-key', {
        provider: mockProvider,
        autocapture: false
      });

      // CRITICAL: accountsChanged should always be registered for state management
      expect(mockProvider.on).toHaveBeenCalledWith('accountsChanged', expect.any(Function));
    });

    it('should not register optional listeners when autocapture is false', async () => {
      const analytics = await FormoAnalytics.init('test-key', {
        provider: mockProvider,
        autocapture: false
      });

      // Optional listeners should NOT be registered
      const chainChangedCalls = (mockProvider.on as jest.Mock).mock.calls.filter(
        call => call[0] === 'chainChanged'
      );
      const connectCalls = (mockProvider.on as jest.Mock).mock.calls.filter(
        call => call[0] === 'connect'
      );
      const disconnectCalls = (mockProvider.on as jest.Mock).mock.calls.filter(
        call => call[0] === 'disconnect'
      );

      expect(chainChangedCalls.length).toBe(0);
      expect(connectCalls.length).toBe(0);
      expect(disconnectCalls.length).toBe(0);
    });
  });

  describe('Granular Event Configuration', () => {
    it('should only register listeners for enabled events', async () => {
      const analytics = await FormoAnalytics.init('test-key', {
        provider: mockProvider,
        autocapture: {
          enabled: true,
          events: {
            connect: true,
            disconnect: true,
            signature: false,
            transaction: false,
            chain: false
          }
        }
      });

      // Should register: accountsChanged (always), connect, disconnect
      expect(mockProvider.on).toHaveBeenCalledWith('accountsChanged', expect.any(Function));
      expect(mockProvider.on).toHaveBeenCalledWith('connect', expect.any(Function));
      expect(mockProvider.on).toHaveBeenCalledWith('disconnect', expect.any(Function));

      // Should NOT register: chainChanged
      const chainChangedCalls = (mockProvider.on as jest.Mock).mock.calls.filter(
        call => call[0] === 'chainChanged'
      );
      expect(chainChangedCalls.length).toBe(0);
    });

    it('should respect individual event settings', async () => {
      const analytics = await FormoAnalytics.init('test-key', {
        autocapture: {
          enabled: true,
          events: {
            connect: true,
            disconnect: false,
            signature: true,
            transaction: false,
            chain: true
          }
        }
      });

      const isConnect = (analytics as any).isWalletAutocaptureEnabled('connect');
      const isDisconnect = (analytics as any).isWalletAutocaptureEnabled('disconnect');
      const isSignature = (analytics as any).isWalletAutocaptureEnabled('signature');
      const isTransaction = (analytics as any).isWalletAutocaptureEnabled('transaction');
      const isChain = (analytics as any).isWalletAutocaptureEnabled('chain');

      expect(isConnect).toBe(true);
      expect(isDisconnect).toBe(false);
      expect(isSignature).toBe(true);
      expect(isTransaction).toBe(false);
      expect(isChain).toBe(true);
    });

    it('should disable all events when enabled is false, regardless of individual settings', async () => {
      const analytics = await FormoAnalytics.init('test-key', {
        autocapture: {
          enabled: false,
          events: {
            connect: true,
            signature: true
          }
        }
      });

      const isConnect = (analytics as any).isWalletAutocaptureEnabled('connect');
      const isSignature = (analytics as any).isWalletAutocaptureEnabled('signature');

      expect(isConnect).toBe(false);
      expect(isSignature).toBe(false);
    });
  });

  describe('State Management', () => {
    it('should always register accountsChanged for state management', async () => {
      const analytics = await FormoAnalytics.init('test-key', {
        provider: mockProvider,
        autocapture: {
          enabled: true,
          events: {
            connect: false,
            disconnect: false
          }
        }
      });

      // accountsChanged should always be registered to maintain state
      expect(mockProvider.on).toHaveBeenCalledWith('accountsChanged', expect.any(Function));
    });

    it('should update internal state even when connect tracking is disabled', async () => {
      const analytics = await FormoAnalytics.init('test-key', {
        provider: mockProvider,
        autocapture: {
          enabled: true,
          events: {
            connect: false,
            disconnect: true
          }
        }
      });

      // Get the accountsChanged listener
      const accountsChangedListener = (mockProvider.on as jest.Mock).mock.calls.find(
        call => call[0] === 'accountsChanged'
      )?.[1];

      expect(accountsChangedListener).toBeDefined();

      // Trigger accountsChanged with accounts (simulate connect)
      if (accountsChangedListener) {
        await accountsChangedListener(['0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb']);
      }

      // State should be updated even though connect tracking is disabled
      expect((analytics as any).currentAddress).toBeDefined();
      expect((analytics as any).currentAddress).toContain('0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb');
      expect((analytics as any).currentChainId).toBeDefined();
    });

    it('should maintain state for disconnect events when only disconnect tracking is enabled', async () => {
      const analytics = await FormoAnalytics.init('test-key', {
        provider: mockProvider,
        autocapture: {
          enabled: true,
          events: {
            connect: false,
            disconnect: true
          }
        }
      });

      // Get the accountsChanged listener
      const accountsChangedListener = (mockProvider.on as jest.Mock).mock.calls.find(
        call => call[0] === 'accountsChanged'
      )?.[1];

      // First trigger connect (state should be updated but no event emitted)
      if (accountsChangedListener) {
        await accountsChangedListener(['0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb']);
      }

      const addressAfterConnect = (analytics as any).currentAddress;
      const chainIdAfterConnect = (analytics as any).currentChainId;

      expect(addressAfterConnect).toBeDefined();
      expect(chainIdAfterConnect).toBeDefined();

      // Now trigger disconnect - state should be used for disconnect event
      if (accountsChangedListener) {
        await accountsChangedListener([]);
      }

      // After disconnect, state should be cleared
      expect((analytics as any).currentAddress).toBeUndefined();
      expect((analytics as any).currentChainId).toBeUndefined();
    });
  });

  describe('Listener Registration Optimization', () => {
    it('should not register chainChanged when chain tracking is disabled', async () => {
      const analytics = await FormoAnalytics.init('test-key', {
        provider: mockProvider,
        autocapture: {
          enabled: true,
          events: {
            chain: false
          }
        }
      });

      const chainChangedCalls = (mockProvider.on as jest.Mock).mock.calls.filter(
        call => call[0] === 'chainChanged'
      );
      expect(chainChangedCalls.length).toBe(0);
    });

    it('should not register connect listener when connect tracking is disabled', async () => {
      const analytics = await FormoAnalytics.init('test-key', {
        provider: mockProvider,
        autocapture: {
          enabled: true,
          events: {
            connect: false
          }
        }
      });

      const connectCalls = (mockProvider.on as jest.Mock).mock.calls.filter(
        call => call[0] === 'connect'
      );
      expect(connectCalls.length).toBe(0);
    });

    it('should not register disconnect listener when disconnect tracking is disabled', async () => {
      const analytics = await FormoAnalytics.init('test-key', {
        provider: mockProvider,
        autocapture: {
          enabled: true,
          events: {
            disconnect: false
          }
        }
      });

      const disconnectCalls = (mockProvider.on as jest.Mock).mock.calls.filter(
        call => call[0] === 'disconnect'
      );
      expect(disconnectCalls.length).toBe(0);
    });
  });
});

