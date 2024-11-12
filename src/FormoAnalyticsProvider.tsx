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

export const FormoAnalyticsContext = createContext<FormoAnalytics | undefined>(
  undefined
);

export const FormoAnalyticsProvider = ({
  apiKey,
  projectId,
  disabled,
  children,
}: FormoAnalyticsProviderProps) => {
  const [sdk, setSdk] = useState<FormoAnalytics | undefined>();
  const initializedStartedRef = useRef(false);

  useEffect(() => {
    if (!apiKey) {
      throw new Error('FormoAnalyticsProvider: No API key provided');
    }

    if (disabled) return;

    if (initializedStartedRef.current) return;
    initializedStartedRef.current = true;

    H.init(process.env.HIGHLIGHT_PROJECT_ID, {
      serviceName: 'formo-analytics-sdk',
      tracingOrigins: true,
      networkRecording: {
        enabled: true,
        recordHeadersAndBody: true,
        urlBlocklist: [
          // insert full or partial urls that you don't want to record here
          // Out of the box, Highlight will not record these URLs (they can be safely removed):
          'https://www.googleapis.com/identitytoolkit',
          'https://securetoken.googleapis.com',
        ],
      },
    });

    FormoAnalytics.init(apiKey, projectId).then((sdkInstance) =>
      setSdk(sdkInstance)
    );
  }, [apiKey, disabled, projectId]);

  return (
    <ErrorBoundary onError={(error, info) => H.consumeError(error, info)}>
      <FormoAnalyticsContext.Provider value={sdk}>
        {children}
      </FormoAnalyticsContext.Provider>
    </ErrorBoundary>
  );
};

export const useFormoAnalytics = () => {
  const context = useContext(FormoAnalyticsContext);

  if (!context) {
    throw new Error(
      'useFormoAnalytics must be used within a FormoAnalyticsProvider'
    );
  }

  return context;
};
