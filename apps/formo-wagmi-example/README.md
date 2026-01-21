# Formo Analytics React Native Example

This is an example React Native app demonstrating the [@formo/react-native-analytics](https://github.com/getformo/sdk/tree/main/packages/react-native) SDK with Wagmi integration.

## Features

- **Automatic Wallet Event Tracking**: Connect, disconnect, chain changes, signatures, and transactions are automatically tracked with Wagmi integration
- **Screen Tracking**: Track screen views for navigation analytics
- **Custom Event Tracking**: Send custom events with properties
- **Semantic Events**: Track revenue, points, and volume events
- **Consent Management**: Built-in opt-out/opt-in functionality for GDPR compliance

## Getting Started

### Prerequisites

- Node.js 18+
- pnpm, npm, or yarn
- Expo CLI
- Xcode (for iOS development)
- Android Studio (for Android development)

### Installation

1. Clone the repository:

```bash
git clone https://github.com/getformo/formo-examples-react-native.git
cd formo-examples-react-native
```

2. Install dependencies:

```bash
pnpm install
# or
npm install
# or
yarn install
```

3. Create a `.env` file with your API keys:

```bash
cp .env.example .env
```

Edit `.env` and add your keys:

```
EXPO_PUBLIC_FORMO_WRITE_KEY=your_formo_write_key
EXPO_PUBLIC_REOWN_PROJECT_ID=your_reown_project_id
```

4. Start the development server:

```bash
pnpm start
# or
npm start
# or
yarn start
```

### Running on Device

- **iOS**: Press `i` in the terminal or scan the QR code with the Expo Go app
- **Android**: Press `a` in the terminal or scan the QR code with the Expo Go app

## Project Structure

```
├── app/
│   ├── _layout.tsx      # Root layout with providers
│   ├── index.tsx        # Home screen
│   ├── wallet.tsx       # Wallet connection screen
│   └── events.tsx       # Event tracking demo screen
├── config/
│   ├── formo.ts         # Formo Analytics configuration
│   └── wagmi.ts         # Wagmi/AppKit configuration
├── components/          # Reusable components
└── assets/              # App assets (icons, images)
```

## Configuration

### Formo Analytics

Edit `config/formo.ts` to customize the SDK configuration:

```typescript
export const formoOptions: Options = {
  // Wagmi integration
  wagmi: {
    config: wagmiConfig,
    queryClient: queryClient,
  },

  // App information
  app: {
    name: "Your App Name",
    version: "1.0.0",
  },

  // Event batching
  flushAt: 10,
  flushInterval: 15000,

  // Logging
  logger: {
    enabled: __DEV__,
    levels: ["debug", "info", "warn", "error"],
  },
};
```

### Wagmi/AppKit

Edit `config/wagmi.ts` to customize wallet connection:

```typescript
const projectId = "your_reown_project_id";

const chains = [mainnet, polygon, arbitrum, optimism, base] as const;

const metadata = {
  name: "Your App Name",
  description: "Your app description",
  url: "https://yourapp.com",
  icons: ["https://yourapp.com/icon.png"],
};
```

## Usage Examples

### Track Screen Views

```typescript
import { useFormo } from "@formo/react-native-analytics";
import { useEffect } from "react";

function MyScreen() {
  const formo = useFormo();

  useEffect(() => {
    formo.screen("MyScreen", {
      category: "main",
      source: "navigation",
    });
  }, []);

  return <View>...</View>;
}
```

### Track Custom Events

```typescript
const formo = useFormo();

// Simple event
formo.track("button_pressed", {
  buttonName: "signup",
  screen: "home",
});

// Revenue event
formo.track("purchase_completed", {
  revenue: 99.99,
  currency: "USD",
  productId: "nft-001",
});

// Points event
formo.track("achievement_unlocked", {
  points: 500,
  achievementId: "first_tx",
});
```

### Manual Wallet Events

While wallet events are automatically tracked with Wagmi integration, you can also track them manually:

```typescript
// Connect
formo.connect({
  chainId: 1,
  address: "0x...",
});

// Disconnect
formo.disconnect();

// Chain change
formo.chain({
  chainId: 137,
  address: "0x...",
});

// Signature
formo.signature({
  status: SignatureStatus.CONFIRMED,
  chainId: 1,
  address: "0x...",
  message: "Sign this message",
  signatureHash: "0x...",
});

// Transaction
formo.transaction({
  status: TransactionStatus.BROADCASTED,
  chainId: 1,
  address: "0x...",
  to: "0x...",
  value: "1000000000000000000",
  transactionHash: "0x...",
});
```

## Resources

- [Formo Documentation](https://docs.formo.so)
- [Formo React Native SDK](https://github.com/getformo/sdk/tree/main/packages/react-native)
- [Reown AppKit](https://docs.reown.com/appkit/react-native/core/installation)
- [Wagmi Documentation](https://wagmi.sh)
- [Expo Documentation](https://docs.expo.dev)

## License

MIT
