import { createContext, useContext, useEffect, useRef, useState, ReactNode, FC } from "react";
import { FormoAnalytics } from "./FormoAnalytics";
import { initStorageManager, logger } from "./lib";
import { FormoAnalyticsProviderProps, IFormoAnalytics } from "./types";

const defaultContext: IFormoAnalytics = {
  chain: () => Promise.resolve(),
  page: () => Promise.resolve(),
  reset: () => {},
  detect: () => Promise.resolve(),
  connect: () => Promise.resolve(),
  disconnect: () => Promise.resolve(),
  signature: () => Promise.resolve(),
  transaction: () => Promise.resolve(),
  identify: () => Promise.resolve(),
  track: () => Promise.resolve(),
  
  // Consent management methods
  optOutTracking: () => {},
  hasOptedOutTracking: () => false,
  setConsent: () => {},
  getConsent: () => null,
  clearConsent: () => {},
};

export const FormoAnalyticsContext =
  createContext<IFormoAnalytics>(defaultContext);

export const FormoAnalyticsProvider: FC<FormoAnalyticsProviderProps> = (props) => {
  const { writeKey, disabled = false, children } = props;

  // Keep the app running without analytics if no Write Key is provided or disabled
  if (!writeKey) {
    logger.error("FormoAnalyticsProvider: No Write Key provided");
    return <>{children}</>;
  }

  if (disabled) {
    logger.warn("FormoAnalytics is disabled");
    return <>{children}</>;
  }

  return <InitializedAnalytics {...props} />;
};

const InitializedAnalytics: FC<FormoAnalyticsProviderProps> = ({
  writeKey,
  options,
  children,
}) => {
  const [sdk, setSdk] = useState<IFormoAnalytics>(defaultContext);
  const initializedStartedRef = useRef(false);
  initStorageManager(writeKey);

  useEffect(() => {
    const initialize = async () => {
      if (initializedStartedRef.current) return;
      initializedStartedRef.current = true;

      try {
        const sdkInstance = await FormoAnalytics.init(writeKey, options);
        setSdk(sdkInstance);
        logger.log("Successfully initialized");
      } catch (error) {
        logger.error("Failed to initialize", error);
      }
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
