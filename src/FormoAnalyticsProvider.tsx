import { createContext, useContext, useEffect, useState, useRef } from "react";
import { FormoAnalytics } from "./FormoAnalytics";
import { FormoAnalyticsProviderProps } from "./types";
import { logger } from "./lib";

export const FormoAnalyticsContext = createContext<FormoAnalytics | undefined>(
  undefined
);

export const FormoAnalyticsProvider = (props: FormoAnalyticsProviderProps) => {
  const { writeKey, disabled, children } = props;

  // Keep the app running without analytics if no Write Key is provided or disabled
  if (!writeKey) {
    logger.error("FormoAnalyticsProvider: No Write Key provided");
    return children;
  }

  if (disabled) {
    logger.warn("FormoAnalytics is disabled");
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
      logger.log("FormoAnalytics SDK initialized successfully");
    } catch (error) {
      logger.error("Failed to initialize FormoAnalytics SDK", error);
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

export const useFormo = () => {
  const context = useContext(FormoAnalyticsContext);

  if (!context) {
    logger.warn("useFormo called without a valid context");
  }

  return context; // Return undefined if SDK is not initialized, handle accordingly in consumer
};
