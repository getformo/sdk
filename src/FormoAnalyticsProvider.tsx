import { createContext, useContext, useEffect, useState, useRef } from 'react';
import { FormoAnalytics } from './FormoAnalytics';
import { FormoAnalyticsProviderProps } from './types';

export const FormoAnalyticsContext = createContext<FormoAnalytics | undefined>(
  undefined
);

export const FormoAnalyticsProvider = ({
  apiKey: initialApiKey,
  config,
  disabled,
  children,
}: FormoAnalyticsProviderProps) => {
  const [apiKey, setApiKey] = useState<string>(initialApiKey);

  const [sdk, setSdk] = useState<FormoAnalytics | undefined>();
  const initializedStartedRef = useRef(false);

  useEffect(() => {
    const scriptTag = document.querySelector('script[data-token]');

    if (scriptTag) {
      const token = scriptTag.getAttribute('data-token') || '';
      setApiKey(token);
    }

    if (!(initialApiKey && apiKey)) {
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
