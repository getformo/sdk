import { FormoAnalytics } from "./FormoAnalytics";

export * from "./FormoAnalyticsProvider";
export * from "./FormoAnalytics";
export * from "./types";

export function formofy(writeKey: string) {
  if (writeKey && typeof window !== "undefined") {
    FormoAnalytics.init(writeKey)
      .then((f) => {
        (window as any).formo = f;
      })
      .catch((e) => console.error("Error initializing FormoAnalytics:", e));
  } else {
    console.warn("FormoAnalytics not found");
  }
}

(window as any).formofy = formofy;
