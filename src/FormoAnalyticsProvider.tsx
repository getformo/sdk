import { createContext, useContext, useEffect, useMemo, useRef, useState, FC } from "react";
import { FormoAnalytics } from "./FormoAnalytics";
import { initStorageManager } from "./storage";
import { logger } from "./logger";
import { FormoAnalyticsProviderProps, IFormoAnalytics } from "./types";

const defaultContext: IFormoAnalytics = {
  chain: () => Promise.resolve(),
  page: () => Promise.resolve(),
  reset: () => {},
  cleanup: () => {},
  detect: () => Promise.resolve(),
  connect: () => Promise.resolve(),
  disconnect: () => Promise.resolve(),
  signature: () => Promise.resolve(),
  transaction: () => Promise.resolve(),
  identify: () => Promise.resolve(),
  track: () => Promise.resolve(),
  
  // Consent management methods
  optOutTracking: () => {},
  optInTracking: () => {},
  hasOptedOutTracking: () => false,
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
  const sdkRef = useRef<IFormoAnalytics>(defaultContext);
  initStorageManager(writeKey);

  // Create a stable key from options that ignores complex objects and functions
  // We only care about serializable config values that would affect SDK behavior
  const optionsKey = useMemo(() => {
    if (!options) return 'undefined';
    
    // Extract only the serializable parts of options
    const serializableOptions = {
      tracking: options.tracking,
      autocapture: options.autocapture,
      apiHost: options.apiHost,
      flushAt: options.flushAt,
      flushInterval: options.flushInterval,
      retryCount: options.retryCount,
      maxQueueSize: options.maxQueueSize,
      logger: options.logger,
      referral: options.referral,
      // For complex objects, just track their presence, not their content
      hasProvider: !!options.provider,
      hasWagmi: !!options.wagmi,
      hasReady: !!options.ready,
    };
    
    try {
      return JSON.stringify(serializableOptions);
    } catch (error) {
      // Fallback to timestamp if serialization fails
      logger.warn('Failed to serialize options, using timestamp', error);
      return Date.now().toString();
    }
  }, [options]);

  useEffect(() => {
    let isCleanedUp = false;

    const initialize = async () => {
      // Clean up existing SDK instance before creating a new one
      if (sdkRef.current && sdkRef.current !== defaultContext) {
        logger.log("Cleaning up existing FormoAnalytics SDK instance before re-initialization");
        sdkRef.current.cleanup();
        sdkRef.current = defaultContext;
        setSdk(defaultContext);
      }

      try {
        const sdkInstance = await FormoAnalytics.init(writeKey, options);
        
        // Only set SDK if the component hasn't been cleaned up during async initialization
        if (!isCleanedUp) {
          setSdk(sdkInstance);
          sdkRef.current = sdkInstance;
          logger.log("Successfully initialized FormoAnalytics SDK");
        } else {
          // Component was unmounted during initialization, clean up immediately
          logger.log("Component unmounted during initialization, cleaning up SDK");
          sdkInstance.cleanup();
        }
      } catch (error) {
        if (!isCleanedUp) {
          logger.error("Failed to initialize FormoAnalytics SDK", error);
        }
      }
    };

    initialize();

    // Cleanup function to prevent memory leaks
    // Using ref ensures we clean up the actual SDK instance, not the stale closure value
    return () => {
      isCleanedUp = true;
      
      if (sdkRef.current && sdkRef.current !== defaultContext) {
        logger.log("Cleaning up FormoAnalytics SDK instance");
        sdkRef.current.cleanup();
        sdkRef.current = defaultContext;
      }
    };
  }, [writeKey, optionsKey]);

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
