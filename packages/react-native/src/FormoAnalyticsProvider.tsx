import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  FC,
} from "react";
import { FormoAnalytics } from "./FormoAnalytics";
import { initStorageManager, AsyncStorageInterface } from "./lib/storage";
import { logger } from "./lib/logger";
import { FormoAnalyticsProviderProps, IFormoAnalytics } from "./types";

// Default context with no-op methods
const defaultContext: IFormoAnalytics = {
  chain: () => Promise.resolve(),
  screen: () => Promise.resolve(),
  reset: () => {},
  cleanup: () => {},
  detect: () => Promise.resolve(),
  connect: () => Promise.resolve(),
  disconnect: () => Promise.resolve(),
  signature: () => Promise.resolve(),
  transaction: () => Promise.resolve(),
  identify: () => Promise.resolve(),
  track: () => Promise.resolve(),
  optOutTracking: () => {},
  optInTracking: () => {},
  hasOptedOutTracking: () => false,
};

export const FormoAnalyticsContext =
  createContext<IFormoAnalytics>(defaultContext);

export interface FormoAnalyticsProviderPropsWithStorage
  extends FormoAnalyticsProviderProps {
  /**
   * AsyncStorage instance from @react-native-async-storage/async-storage
   * Required for persistent storage
   */
  asyncStorage?: AsyncStorageInterface;
}

/**
 * Formo Analytics Provider for React Native
 *
 * Wraps your app to provide analytics context
 *
 * @example
 * ```tsx
 * import AsyncStorage from '@react-native-async-storage/async-storage';
 * import { FormoAnalyticsProvider } from '@formo/react-native-analytics';
 *
 * function App() {
 *   return (
 *     <FormoAnalyticsProvider
 *       writeKey="your-write-key"
 *       asyncStorage={AsyncStorage}
 *       options={{ wagmi: { config, queryClient } }}
 *     >
 *       <YourApp />
 *     </FormoAnalyticsProvider>
 *   );
 * }
 * ```
 */
export const FormoAnalyticsProvider: FC<FormoAnalyticsProviderPropsWithStorage> = (
  props
) => {
  const { writeKey, disabled = false, children } = props;

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

const InitializedAnalytics: FC<FormoAnalyticsProviderPropsWithStorage> = ({
  writeKey,
  options,
  asyncStorage,
  children,
}) => {
  const [sdk, setSdk] = useState<IFormoAnalytics>(defaultContext);
  const sdkRef = useRef<IFormoAnalytics>(defaultContext);
  initStorageManager(writeKey);

  // Create stable key from options
  const optionsKey = useMemo(() => {
    if (!options) return "undefined";

    const serializableOptions = {
      tracking: options.tracking,
      autocapture: options.autocapture,
      apiHost: options.apiHost,
      flushAt: options.flushAt,
      flushInterval: options.flushInterval,
      retryCount: options.retryCount,
      maxQueueSize: options.maxQueueSize,
      logger: options.logger,
      app: options.app,
      hasWagmi: !!options.wagmi,
      hasReady: !!options.ready,
    };

    try {
      return JSON.stringify(serializableOptions);
    } catch (error) {
      logger.warn("Failed to serialize options, using timestamp", error);
      return Date.now().toString();
    }
  }, [options]);

  useEffect(() => {
    let isCleanedUp = false;

    const initialize = async () => {
      // Clean up existing SDK
      if (sdkRef.current && sdkRef.current !== defaultContext) {
        logger.log("Cleaning up existing FormoAnalytics SDK instance");
        sdkRef.current.cleanup();
        sdkRef.current = defaultContext;
        setSdk(defaultContext);
      }

      try {
        const sdkInstance = await FormoAnalytics.init(
          writeKey,
          options,
          asyncStorage
        );

        if (!isCleanedUp) {
          setSdk(sdkInstance);
          sdkRef.current = sdkInstance;
          logger.log("Successfully initialized FormoAnalytics SDK");
        } else {
          logger.log("Component unmounted during initialization, cleaning up");
          sdkInstance.cleanup();
        }
      } catch (error) {
        if (!isCleanedUp) {
          logger.error("Failed to initialize FormoAnalytics SDK", error);
        }
      }
    };

    initialize();

    return () => {
      isCleanedUp = true;

      if (sdkRef.current && sdkRef.current !== defaultContext) {
        logger.log("Cleaning up FormoAnalytics SDK instance");
        sdkRef.current.cleanup();
        sdkRef.current = defaultContext;
      }
    };
  }, [writeKey, optionsKey, asyncStorage]);

  return (
    <FormoAnalyticsContext.Provider value={sdk}>
      {children}
    </FormoAnalyticsContext.Provider>
  );
};

/**
 * Hook to access Formo Analytics
 *
 * @example
 * ```tsx
 * import { useFormo } from '@formo/react-native-analytics';
 *
 * function MyScreen() {
 *   const formo = useFormo();
 *
 *   useEffect(() => {
 *     formo.screen('Home');
 *   }, []);
 *
 *   const handleButtonPress = () => {
 *     formo.track('Button Pressed', { buttonName: 'signup' });
 *   };
 *
 *   return <Button onPress={handleButtonPress}>Sign Up</Button>;
 * }
 * ```
 */
export const useFormo = (): IFormoAnalytics => {
  const context = useContext(FormoAnalyticsContext);

  if (!context) {
    logger.warn("useFormo called without a valid context");
  }

  return context;
};
