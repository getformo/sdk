export interface FormoAnalyticsConfig {
  trackPageViews?: boolean;
  trackClicks?: boolean;
  trackUserSessions?: boolean;
  [key: string]: any; // Additional config options, if needed
}

export interface FormoAnalyticsProviderProps {
  apiKey: string;
  config?: FormoAnalyticsConfig;
  disabled?: boolean;
  children: React.ReactNode;
}
