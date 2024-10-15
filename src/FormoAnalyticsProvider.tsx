import { createContext, useContext, useEffect, useState, useRef } from 'react';
import { FormoAnalytics } from './FormoAnalytics';
import { FormoAnalyticsProviderProps } from './types';

export const FormoAnalyticsContext = createContext<
  FormoAnalytics | undefined
>(undefined);

export const FormoAnalyticsProvider = ({
  apiKey,
  config,
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

    FormoAnalytics.init(apiKey, {
      ...config,
      trackPageViews: true,
      trackClicks: true,
      trackUserSessions: true,
    }).then((sdkInstance) => setSdk(sdkInstance));
  }, [apiKey, disabled, config]);

  return (
    <FormoAnalyticsContext.Provider value={sdk}>
      {children}
    </FormoAnalyticsContext.Provider>
  );
};

export const useFormoAnalytics = () => {
  return useContext(FormoAnalyticsContext);
};
