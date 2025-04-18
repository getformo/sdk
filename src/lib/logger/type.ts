export interface ILogger {
  setEnabledLevels(levels: LogLevel[]): void;
  getEnabledLevels(): LogLevel[];
  setEnabled(enabled: boolean): void;
  isLoggingEnabled(): boolean;
  log(...data: any[]): void;
  info(...data: any[]): void;
  debug(...data: any[]): void;
  warn(...data: any[]): void;
  error(...data: any[]): void;
  trace(...data: any[]): void;
}

export type LogLevel = "debug" | "info" | "warn" | "error" | "trace";
