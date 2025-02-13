import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useRef,
} from "react";
import { FormoAnalytics } from "./FormoAnalytics";
import { FormoAnalyticsProviderProps } from "./types";

export const FormoAnalyticsContext = createContext<FormoAnalytics | undefined>(
  undefined
);

export const FormoAnalyticsProvider = (props: FormoAnalyticsProviderProps) => {
  const { apiKey, disabled, children } = props;

  // Keep the app running without analytics if no API key is provided or disabled
  if (!apiKey) {
    console.error("FormoAnalyticsProvider: No API key provided");
    return children;
  }

  if (disabled) {
    console.warn("FormoAnalytics is disabled");
    return children;
  }

  return <InitializedAnalytics {...props} />;
};

const InitializedAnalytics = ({
  apiKey,
  options,
  children,
}: FormoAnalyticsProviderProps) => {
  const [sdk, setSdk] = useState<FormoAnalytics | undefined>();
  const [isInitialized, setIsInitialized] = useState(false);
  const initializedStartedRef = useRef(false);

  const initializeFormoAnalytics = async (apiKey: string, options: any) => {
    try {
      const sdkInstance = await FormoAnalytics.init(apiKey, options);
      setSdk(sdkInstance);
      console.log("FormoAnalytics SDK initialized successfully");
    } catch (error) {
      console.error("Failed to initialize FormoAnalytics SDK", error);
    } finally {
      setIsInitialized(true); // Ensure UI renders even after failure
    }
  };

  useEffect(() => {
    const initialize = async () => {
      if (initializedStartedRef.current) return;
      initializedStartedRef.current = true;

      await initializeFormoAnalytics(apiKey, options);
    };

    initialize();
  }, [apiKey, options]);

  if (!isInitialized) {
    // Optionally show a loading state until initialization attempt finishes
    return <div>Loading analytics...</div>;
  }

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
