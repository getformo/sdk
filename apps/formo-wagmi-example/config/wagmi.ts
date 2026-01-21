import { mainnet, polygon, arbitrum, optimism, base } from "wagmi/chains";
import { createAppKit } from "@reown/appkit";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { QueryClient } from "@tanstack/react-query";

// Get your project ID from https://cloud.reown.com
const projectId = process.env.EXPO_PUBLIC_REOWN_PROJECT_ID || "YOUR_PROJECT_ID";

// Define supported chains
const chains = [mainnet, polygon, arbitrum, optimism, base] as const;

// Metadata for the app
const metadata = {
  name: "Formo Analytics Demo",
  description: "Example React Native app with Formo Analytics and Wagmi",
  url: "https://formo.so",
  icons: ["https://formo.so/icon.png"],
};

// Create QueryClient
export const queryClient = new QueryClient();

// Create Wagmi adapter
const wagmiAdapter = new WagmiAdapter({
  networks: chains,
  projectId,
  ssr: false,
});

// Export wagmi config
export const wagmiConfig = wagmiAdapter.wagmiConfig;

// Initialize AppKit
createAppKit({
  adapters: [wagmiAdapter],
  networks: chains,
  metadata,
  projectId,
  features: {
    analytics: true,
    email: false,
    socials: [],
  },
});

export { chains };
