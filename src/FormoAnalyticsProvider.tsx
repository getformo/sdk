import { createContext, useContext, useEffect, useState, useRef } from "react";
import { FormoAnalytics } from "./FormoAnalytics";
import { FormoAnalyticsProviderProps } from "./types";

export const FormoAnalyticsContext = createContext<FormoAnalytics | undefined>(
  undefined
);

export const FormoAnalyticsProvider = (props: FormoAnalyticsProviderProps) => {
  const { writeKey, disabled, children } = props;

  // Keep the app running without analytics if no Write Key is provided or disabled
  if (!writeKey) {
    console.error("FormoAnalyticsProvider: No Write Key provided");
    return children;
  }

  if (disabled) {
    console.warn("FormoAnalytics is disabled");
    return children;
  }

  return <InitializedAnalytics {...props} />;
};

const InitializedAnalytics = ({
  writeKey,
  options,
  children,
}: FormoAnalyticsProviderProps) => {
  const [sdk, setSdk] = useState<FormoAnalytics | undefined>();
  const initializedStartedRef = useRef(false);

  const initializeFormoAnalytics = async (writeKey: string, options: any) => {
    try {
      const sdkInstance = await FormoAnalytics.init(writeKey, options);
      setSdk(sdkInstance);
      console.log("FormoAnalytics SDK initialized successfully");
    } catch (error) {
      console.error("Failed to initialize FormoAnalytics SDK", error);
    }
  };

  useEffect(() => {
    const initialize = async () => {
      if (initializedStartedRef.current) return;
      initializedStartedRef.current = true;

      await initializeFormoAnalytics(writeKey!, options);
    };

    initialize();
  }, [writeKey, options]);

  return (
    <FormoAnalyticsContext.Provider value={sdk}>
      {children}
    </FormoAnalyticsContext.Provider>
  );
};

export const useFormoAnalytics = () => {
  const context = useContext(FormoAnalyticsContext);

  if (!context) {
    console.warn("useFormoAnalytics called without a valid context");
  }

  return context; // Return undefined if SDK is not initialized, handle accordingly in consumer
};
