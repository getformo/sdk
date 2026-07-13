import { formofy } from "./initialization";

export * from "./core";
export * from "./FormoAnalyticsProvider";

// React-only Privy binding. Lives in the root entry (not `core`) because it
// imports React.
export { useIdentifyPrivyUser } from "./privy/react";
export type { UseIdentifyPrivyUserOptions } from "./privy/react";

if (typeof window !== "undefined") window.formofy = formofy;
