import { executingScript, formofy, formofyFromScriptTag } from "./initialization";

export * from "./core";
export * from "./FormoAnalyticsProvider";

if (typeof window !== "undefined") window.formofy = formofy;
// currentScript is the tag running this bundle (CDN snippet); null in module
// bundles, and a tag without data-write-key is ignored.
if (typeof document !== "undefined") formofyFromScriptTag(executingScript(document));
