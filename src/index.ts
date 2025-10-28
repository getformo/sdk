import { formofy } from "./initialization";
export * from "./FormoAnalyticsProvider";
export * from "./FormoAnalytics";
export * from "./types";
export * from "./integrations";

if (typeof window !== "undefined") window.formofy = formofy;
