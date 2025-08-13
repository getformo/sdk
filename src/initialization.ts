import { FormoAnalytics } from "./FormoAnalytics";
import { Options } from "./types";

export function formofy(writeKey: string, options?: Options) {
  if (writeKey && typeof window !== "undefined") {
    FormoAnalytics.init(writeKey, options)
      .then((f) => {
        (window as any).formo = f;
        // Call ready callback if provided with proper error handling
        if (options?.ready) {
          // Wrap the callback execution in a try-catch to handle synchronous errors
          try {
            options.ready(f);
          } catch (callbackError) {
            console.error("Error in FormoAnalytics ready callback:", callbackError);
          }
          
          // Note: If the callback returns a Promise (even though typed as void),
          // it's the responsibility of the callback implementation to handle its own errors.
          // This prevents the callback from throwing unhandled rejections.
        }
      })
      .catch((e) => console.error("Error initializing FormoAnalytics:", e));
  } else {
    console.warn("FormoAnalytics not found");
  }
}
