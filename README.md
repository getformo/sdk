# Formo Analytics SDK

The Formo Analytics SDK is a Javascript library that allows you to track and analyze user interactions on your dapp.

## Installation

Please visit Formo's [Developer Docs](https://docs.formo.so) for detailed guides and installation instructions.

## Configuration Options

### Autocapture Configuration

You can configure which events are automatically captured by the SDK:

```js
// Enable all autocapture features with default settings
const analytics = await FormoAnalytics.init('YOUR_API_KEY', {
  autocapture: true
});

// Disable all autocapture features
const analytics = await FormoAnalytics.init('YOUR_API_KEY', {
  autocapture: false
});

// Customize individual autocapture settings
const analytics = await FormoAnalytics.init('YOUR_API_KEY', {
  autocapture: {
    page: true,        // Page visits
    detect: true,      // Wallet detection
    connect: false,    // Wallet connections/disconnections
    chain: false,      // Chain/network changes
    signature: true,   // Message signing
    transaction: false, // Transaction events
  }
});
```

Even with autocapture disabled, you can still manually track events using the SDK's methods.

