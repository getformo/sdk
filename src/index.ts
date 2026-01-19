import { formofy } from "./initialization";
export * from "./FormoAnalyticsProvider";
export * from "./FormoAnalytics";
export * from "./types";
export * from "./solana";
export {
  isValidSolanaAddress,
  getValidSolanaAddress,
  isBlockedSolanaAddress,
  detectAddressType,
  shortenSolanaAddress,
} from "./utils/solana-address";

if (typeof window !== "undefined") window.formofy = formofy;
