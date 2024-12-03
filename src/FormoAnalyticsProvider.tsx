import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useRef,
} from 'react';
import { FormoAnalytics } from './FormoAnalytics';
import { FormoAnalyticsProviderProps } from './types';
import { ErrorBoundary } from '@highlight-run/react';
import { H } from 'highlight.run';

const HIGHLIGHT_PROJECT_ID = process.env.REACT_APP_HIGHLIGHT_PROJECT_ID;

export const FormoAnalyticsContext = createContext<FormoAnalytics | undefined>(
  undefined
);

export const FormoAnalyticsProvider = ({
  apiKey,
  options,
  disabled,
  children,
}: FormoAnalyticsProviderProps) => {
  const [sdk, setSdk] = useState<FormoAnalytics | undefined>();
  const [isInitialized, setIsInitialized] = useState(false);
  const initializedStartedRef = useRef(false);

  useEffect(() => {
    const initialize = async () => {
      if (!apiKey) {
        console.error('FormoAnalyticsProvider: No API key provided');
        return;
      }

      if (disabled) {
        console.warn('FormoAnalytics is disabled');
        return;
      }

      if (initializedStartedRef.current) return;
      initializedStartedRef.current = true;

      // Initialize Highlight.run if project ID is available
      if (HIGHLIGHT_PROJECT_ID) {
        try {
          H.init(HIGHLIGHT_PROJECT_ID, {
            serviceName: 'formo-analytics-sdk',
            tracingOrigins: true,
            networkRecording: {
              enabled: true,
              recordHeadersAndBody: true,
              urlBlocklist: [
                'https://www.googleapis.com/identitytoolkit',
                'https://securetoken.googleapis.com',
              ],
            },
          });
          console.log('Highlight.run initialized successfully');
        } catch (error) {
          console.error('Failed to initialize Highlight.run', error);
        }
      }

      // Initialize FormoAnalytics
      try {
        const sdkInstance = await FormoAnalytics.init(apiKey, options);
        setSdk(sdkInstance);
        console.log('FormoAnalytics SDK initialized successfully');
      } catch (error) {
        console.error('Failed to initialize FormoAnalytics SDK', error);
      } finally {
        setIsInitialized(true); // Ensure UI renders even after failure
      }
    };

    initialize();
  }, [apiKey, disabled, options]);

  if (!isInitialized) {
    // Optionally show a loading state until initialization attempt finishes
    return <div>Loading analytics...</div>;
  }

  return (
    <ErrorBoundary onError={(error, info) => H?.consumeError(error, info)}>
      <FormoAnalyticsContext.Provider value={sdk}>
        {children}
      </FormoAnalyticsContext.Provider>
    </ErrorBoundary>
  );
};

export const useFormoAnalytics = () => {
  const context = useContext(FormoAnalyticsContext);

  if (!context) {
    console.warn('useFormoAnalytics called without a valid context');
  }

  return context; // Return undefined if SDK is not initialized, handle accordingly in consumer
};
