import { formofy } from "./initialization";
export * from "./FormoAnalyticsProvider";
export * from "./FormoAnalytics";
export * from "./types";

(window as any).formofy = formofy;
