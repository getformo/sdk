import { createContext, useContext, useEffect, useState, useRef } from 'react';
import { FormoAnalytics } from './FormoAnalytics';
import { FormoAnalyticsProviderProps } from './types';

export const FormoAnalyticsContext = createContext<FormoAnalytics | undefined>(
  undefined
);

export const FormoAnalyticsProvider = ({
  apiKey: initialApiKey,
  disabled,
  children,
}: FormoAnalyticsProviderProps) => {
  const [apiKey, setApiKey] = useState<string | undefined>(initialApiKey);

  const [sdk, setSdk] = useState<FormoAnalytics | undefined>();
  const initializedStartedRef = useRef(false);

  useEffect(() => {
    const scriptTag = document.querySelector('script[data-apikey]');

    if (scriptTag) {
      const providedApiKey = scriptTag.getAttribute('data-apikey') || '';
      setApiKey(providedApiKey);
    }

    if (!(initialApiKey && apiKey)) {
      throw new Error('FormoAnalyticsProvider: No API key provided');
    }

    if (disabled) return;

    if (initializedStartedRef.current) return;
    initializedStartedRef.current = true;

    FormoAnalytics.init(apiKey).then((sdkInstance) => setSdk(sdkInstance));
  }, [apiKey, disabled]);

  return (
    <FormoAnalyticsContext.Provider value={sdk}>
      {children}
    </FormoAnalyticsContext.Provider>
  );
};

export const useFormoAnalytics = () => {
  const context = useContext(FormoAnalyticsContext);

  if (!context) {
    throw new Error('useFormoAnalytics must be used within a FormoAnalyticsProvider');
  }

  return context;
};
