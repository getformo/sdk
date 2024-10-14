export const LIBRARY_USAGE_HEADER = 'X-Library-Usage'
export type LibraryType = 'script-tag' | 'npm-package'

export type SdkConfig = {
  /* ---------------------------- Internal settings --------------------------- */
  cacheIdentity: boolean
  url: string

  /* ---------------------------- Tracking options ---------------------------- */
  trackPages: boolean
  trackWalletConnections: boolean
  trackChainChanges: boolean
  trackTransactions: boolean
  trackSigning: boolean
  trackClicks: boolean
}

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
