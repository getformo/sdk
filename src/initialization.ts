import { FormoAnalytics } from "./FormoAnalytics";
import { Options } from "./types";

export function formofy(writeKey: string, options?: Options) {
  if (writeKey && typeof window !== "undefined") {
    FormoAnalytics.init(writeKey, options)
      .then((f) => {
        (window as any).formo = f;
      })
      .catch((e) => console.error("Error initializing FormoAnalytics:", e));
  } else {
    console.warn("FormoAnalytics not found");
  }
}
