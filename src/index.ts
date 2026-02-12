import { formofy } from "./initialization";
export * from "./FormoAnalyticsProvider";
export * from "./FormoAnalytics";
export * from "./types";
export { extractPrivyProperties, getPrivyWalletAddresses } from "./privy";
export type { PrivyUser, PrivyLinkedAccount, PrivyAccountType, PrivyProfileProperties, PrivyWalletInfo } from "./privy";

if (typeof window !== "undefined") window.formofy = formofy;
