import { formofy } from "./initialization";
export * from "./FormoAnalyticsProvider";
export * from "./FormoAnalytics";
export * from "./types";
export { extractPrivyProperties } from "./privy";
export type { PrivyUser, PrivyLinkedAccount, PrivyLinkedAccountSummary, PrivyAccountType, PrivyProfileProperties } from "./privy";

if (typeof window !== "undefined") window.formofy = formofy;
