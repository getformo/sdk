import { formofy } from "./initialization";

export * from "./core";
export * from "./FormoAnalyticsProvider";

if (typeof window !== "undefined") window.formofy = formofy;
