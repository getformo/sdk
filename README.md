<p align="center">
	<h1 align="center"><b>Formo Web SDK</b></h1>
<p align="center">
    Unified analytics for onchain apps.
    <br />
    <a href="https://formo.so">Website</a>
    ·
    <a href="https://docs.formo.so">Docs</a>
    ·
    <a href="https://app.formo.so">Dashboard</a>
    ·
    <a href="https://formo.so/slack">Slack</a>
    ·
    <a href="https://twitter.com/getformo">X</a>
  </p>
</p>

## Installation

The Formo Web SDK is a Javascript library that allows you to track and analyze user interactions on your dapp. 

You can install Formo on:
- [Websites](https://docs.formo.so/install#website)
- [React apps](https://docs.formo.so/install#react)
- [Next.js apps](https://docs.formo.so/install#next-js-app-router)

## Integrations

### Wagmi Integration

Formo now provides seamless integration with [Wagmi](https://wagmi.sh/) for automatic wallet event tracking:

#### Drop-in Replacement (Easiest for Existing Apps)
```tsx
// 1. Use the unified provider
import { WagmiFormoProvider } from '@formo/analytics/wagmi';

// 2. Change hook imports (everything else stays the same!)
import { useSignMessage, useSendTransaction } from '@formo/analytics/wagmi';

function App() {
  return (
    <WagmiProvider config={wagmiConfig}>
      <WagmiFormoProvider writeKey="your-write-key">
        <YourApp />
      </WagmiFormoProvider>
    </WagmiProvider>
  );
}
```

#### Simple Setup
```tsx
import { WagmiProvider } from 'wagmi';
import { WagmiFormoProvider } from '@formo/analytics/wagmi';

function App() {
  return (
    <WagmiProvider config={wagmiConfig}>
      <WagmiFormoProvider writeKey="your-write-key">
        <YourApp />
      </WagmiFormoProvider>
    </WagmiProvider>
  );
}
```

**Features:**
- ✅ **Drop-in replacement hooks** - Just change import statements
- ✅ Automatic wallet connect/disconnect tracking
- ✅ Chain switching events
- ✅ Single unified provider
- ✅ Full TypeScript support

[📖 Read the Wagmi Integration Guide](./docs/WAGMI_INTEGRATION.md)

## Configuration

Visit Formo's [Developer Docs](https://docs.formo.so) for detailed guides on local testing, debugging, and consent management.

## Methodology

Learn how Formo handles [onchain attribution](https://docs.formo.so/data/attribution) and [data collection](https://docs.formo.so/data/what-we-collect).

## Support

Join the [Formo community Slack channel](https://formo.so/slack) for help and questions.

## Contributing

[Contributions](https://github.com/getformo/sdk/blob/main/CONTRIBUTING.md) are welcome! Feel free to open fixes and feature suggestions.

