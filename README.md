# Formo Analytics SDK

The Formo Analytics SDK is a Javascript library that allows you to track and analyze user interactions on your dapp.

## Installation

Please visit Formo's [Developer Docs](https://docs.formo.so) for detailed guides and installation instructions.

## Environment Configuration

The SDK provides a flexible way to control tracking behavior in different environments:

```javascript
// Initialize with environment control options
const analytics = await FormoAnalytics.init("your-write-key", {
  // Option 1: Simple boolean flag to enable/disable tracking
  shouldTrack: false, // Disable tracking completely
  
  // Option 2: Function for dynamic control based on context
  shouldTrack: (context) => {
    const { hostname, pathname, chainId, isLocalhost } = context;
    
    // Skip tracking on development environments
    if (isLocalhost || hostname.includes('staging') || hostname.includes('dev')) {
      return false;
    }
    
    // Skip tracking on testnet chains
    const testnetChainIds = [3, 4, 5, 42, 80001, 421611, 421613, 97, 43113];
    if (chainId && testnetChainIds.includes(Number(chainId))) {
      return false;
    }
    
    // Skip tracking for specific pages
    if (pathname.includes('/admin') || pathname.includes('/test')) {
      return false;
    }
    
    return true;
  }
});
```

### Default Behavior

By default, the SDK will:
- Skip tracking on localhost environments
- Track all other environments

### Multiple Environments

For applications with multiple environments, you can use environment variables or conditional logic:

```javascript
// Example with environment variables
const WRITE_KEY = process.env.REACT_APP_FORMO_WRITE_KEY;
const ENV = process.env.REACT_APP_ENVIRONMENT; // 'production', 'staging', 'development'

// Initialize with appropriate configuration
const analytics = await FormoAnalytics.init(WRITE_KEY, {
  shouldTrack: ENV === 'production',
});

// Or with more granular control
const analytics = await FormoAnalytics.init(WRITE_KEY, {
  shouldTrack: (context) => {
    // Only track in production, or in staging but not on test pages
    if (ENV === 'production') return true;
    if (ENV === 'staging' && !context.pathname.includes('/test')) return true;
    return false;
  }
});
```

