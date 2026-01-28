import { wagmiConfig, queryClient } from "./wagmi";
import type { Options } from "@formo/react-native-analytics";

// Get your write key from https://app.formo.so
export const FORMO_WRITE_KEY =
  process.env.EXPO_PUBLIC_FORMO_WRITE_KEY || "YOUR_FORMO_WRITE_KEY";

// Module-level callback to avoid inline arrow function reference issues
const handleReady = () => {
  console.log("Formo Analytics initialized successfully!");
};

// Formo Analytics configuration
export const formoOptions: Options = {
  // Wagmi integration - automatically tracks wallet events
  wagmi: {
    config: wagmiConfig,
    queryClient: queryClient,
  },

  // App information for context enrichment
  app: {
    name: "Formo Analytics Demo",
    version: "1.0.0",
    bundleId: "com.formo.analytics.demo",
  },

  // Event batching configuration
  flushAt: 10, // Flush after 10 events
  flushInterval: 15000, // Flush every 15 seconds

  // Enable logging in development
  logger: {
    enabled: __DEV__,
    levels: ["debug", "info", "warn", "error"],
  },

  // Ready callback
  ready: handleReady,
};
