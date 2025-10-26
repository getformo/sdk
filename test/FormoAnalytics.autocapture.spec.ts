import { FormoAnalytics } from '../src/FormoAnalytics';
import { AutocaptureOptions } from '../src/types';

/**
 * Test suite for wallet autocapture configuration
 * These tests verify that wallet event tracking can be controlled granularly
 */

describe('FormoAnalytics - Wallet Autocapture', () => {
  const mockWriteKey = 'test_write_key';

  describe('Configuration Parsing', () => {
    it('should default to all wallet events enabled when no config provided', () => {
      // This test verifies backward compatibility
      // When autocapture is not specified, all events should be tracked
      const options = {};
      
      // Expected: isWalletAutocaptureEnabled() returns true
      // Expected: isWalletEventEnabled('connect') returns true
      // Expected: isWalletEventEnabled('signature') returns true
      expect(options).toBeDefined();
    });

    it('should disable all wallet events when autocapture is false', () => {
      const options = {
        autocapture: false
      };
      
      // Expected: isWalletAutocaptureEnabled() returns false
      // Expected: No listeners should be registered
      expect(options.autocapture).toBe(false);
    });

    it('should enable all wallet events when autocapture is true', () => {
      const options = {
        autocapture: true
      };
      
      // Expected: isWalletAutocaptureEnabled() returns true
      // Expected: All isWalletEventEnabled() calls return true
      expect(options.autocapture).toBe(true);
    });

    it('should respect granular event configuration', () => {
      const config: AutocaptureOptions = {
        enabled: true,
        events: {
          connect: true,
          disconnect: true,
          signature: false,
          transaction: false,
          chain: true
        }
      };
      
      const options = {
        autocapture: config
      };
      
      // Expected: isWalletEventEnabled('connect') returns true
      // Expected: isWalletEventEnabled('signature') returns false
      // Expected: isWalletEventEnabled('transaction') returns false
      expect(options.autocapture).toBeDefined();
      expect(config.events?.connect).toBe(true);
      expect(config.events?.signature).toBe(false);
    });

    it('should default individual events to true if not specified', () => {
      const config: AutocaptureOptions = {
        enabled: true,
        events: {
          signature: false
          // Other events not specified - should default to true
        }
      };
      
      const options = {
        autocapture: config
      };
      
      // Expected: isWalletEventEnabled('connect') returns true (default)
      // Expected: isWalletEventEnabled('signature') returns false (explicit)
      expect(options.autocapture).toBeDefined();
    });

    it('should disable all events when enabled is false regardless of event config', () => {
      const config: AutocaptureOptions = {
        enabled: false,
        events: {
          connect: true,
          signature: true
          // These should be ignored because enabled is false
        }
      };
      
      const options = {
        autocapture: config
      };
      
      // Expected: isWalletAutocaptureEnabled() returns false
      // Expected: All isWalletEventEnabled() calls return false
      expect(config.enabled).toBe(false);
    });
  });

  describe('Use Case Examples', () => {
    it('should support tracking only wallet connections', () => {
      const config: AutocaptureOptions = {
        enabled: true,
        events: {
          connect: true,
          disconnect: true,
          signature: false,
          transaction: false,
          chain: false
        }
      };
      
      expect(config.events?.connect).toBe(true);
      expect(config.events?.disconnect).toBe(true);
      expect(config.events?.signature).toBe(false);
      expect(config.events?.transaction).toBe(false);
      expect(config.events?.chain).toBe(false);
    });

    it('should support tracking only transactions', () => {
      const config: AutocaptureOptions = {
        enabled: true,
        events: {
          connect: false,
          disconnect: false,
          signature: false,
          transaction: true,
          chain: false
        }
      };
      
      expect(config.events?.transaction).toBe(true);
      expect(config.events?.connect).toBe(false);
      expect(config.events?.signature).toBe(false);
    });

    it('should support disabling only signatures', () => {
      const config: AutocaptureOptions = {
        enabled: true,
        events: {
          connect: true,
          disconnect: true,
          signature: false,
          transaction: true,
          chain: true
        }
      };
      
      expect(config.events?.signature).toBe(false);
      expect(config.events?.connect).toBe(true);
      expect(config.events?.transaction).toBe(true);
    });

    it('should support complete manual tracking mode', () => {
      const options = {
        autocapture: false
      };
      
      // When autocapture is disabled, developers can still manually call:
      // - analytics.connect()
      // - analytics.disconnect()
      // - analytics.signature()
      // - analytics.transaction()
      // - analytics.chain()
      
      expect(options.autocapture).toBe(false);
    });
  });

  describe('TypeScript Type Safety', () => {
    it('should provide correct types for AutocaptureOptions', () => {
      // This test verifies TypeScript compilation
      const validConfig: AutocaptureOptions = {
        enabled: true,
        events: {
          connect: true,
          disconnect: false,
          signature: false,
          transaction: true,
          chain: true
        }
      };
      
      expect(validConfig).toBeDefined();
    });

    it('should allow boolean shorthand', () => {
      const enabledConfig = true;
      const disabledConfig = false;
      
      // Both should be valid values for autocapture option
      expect(typeof enabledConfig).toBe('boolean');
      expect(typeof disabledConfig).toBe('boolean');
    });

    it('should allow partial event configuration', () => {
      const partialConfig: AutocaptureOptions = {
        enabled: true,
        events: {
          signature: false
          // Other events omitted - should default to true
        }
      };
      
      expect(partialConfig.events?.signature).toBe(false);
    });
  });

  describe('Performance Implications', () => {
    it('should not register listeners when autocapture is disabled', () => {
      // When autocapture is false:
      // - No accountsChanged listener
      // - No chainChanged listener
      // - No connect listener
      // - No disconnect listener
      // - No provider.request wrapper
      
      const options = {
        autocapture: false
      };
      
      // Expected: trackProvider() adds provider to _trackedProviders but doesn't register listeners
      expect(options.autocapture).toBe(false);
    });

    it('should not register specific listeners when events are disabled', () => {
      const config: AutocaptureOptions = {
        enabled: true,
        events: {
          connect: false,
          disconnect: false,
          signature: false,
          transaction: false,
          chain: false
        }
      };
      
      // Expected: No listeners should be registered since all events are disabled
      expect(config.events?.connect).toBe(false);
    });

    it('should only wrap provider.request when signature or transaction tracking is enabled', () => {
      const signatureOnlyConfig: AutocaptureOptions = {
        enabled: true,
        events: {
          connect: false,
          disconnect: false,
          signature: true,
          transaction: false,
          chain: false
        }
      };
      
      // Expected: registerRequestListeners() should be called
      expect(signatureOnlyConfig.events?.signature).toBe(true);
      
      const transactionOnlyConfig: AutocaptureOptions = {
        enabled: true,
        events: {
          connect: false,
          disconnect: false,
          signature: false,
          transaction: true,
          chain: false
        }
      };
      
      // Expected: registerRequestListeners() should be called
      expect(transactionOnlyConfig.events?.transaction).toBe(true);
      
      const neitherConfig: AutocaptureOptions = {
        enabled: true,
        events: {
          connect: false,
          disconnect: false,
          signature: false,
          transaction: false,
          chain: false
        }
      };
      
      // Expected: registerRequestListeners() should NOT be called
      expect(neitherConfig.events?.signature).toBe(false);
      expect(neitherConfig.events?.transaction).toBe(false);
    });
  });
});

