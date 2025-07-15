import { formofy } from "./initialization";
export * from "./FormoAnalyticsProvider";
export * from "./FormoAnalytics";
export * from "./types";

if (typeof window !== "undefined") (window as any).formofy = formofy;
