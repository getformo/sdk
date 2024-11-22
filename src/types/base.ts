export type ChainID = string | number

export interface FormoAnalyticsProviderProps {
  apiKey: string;
  projectId: string;
  disabled?: boolean;
  children: React.ReactNode;
}
