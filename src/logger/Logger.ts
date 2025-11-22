import { ILogger, LogLevel } from "./type";

export class Logger implements ILogger {
  private static instance: ILogger;
  private enabledLevels: Set<LogLevel>;
  private enabled: boolean;

  private constructor(
    enabled: boolean = false,
    enabledLevels: LogLevel[] = []
  ) {
    this.enabled = enabled;
    this.enabledLevels = new Set(enabledLevels);
  }

  public static init(config: {
    enabled?: boolean;
    enabledLevels?: LogLevel[];
  }): void {
    // Get or create instance
    const instance = Logger.getInstance();

    // Update configuration
    if (config.enabled !== undefined) {
      instance.setEnabled(config.enabled);
    }
    if (config.enabledLevels !== undefined) {
      instance.setEnabledLevels(config.enabledLevels);
    }
  }

  public static getInstance(config?: {
    enabled?: boolean;
    enabledLevels?: LogLevel[];
  }): ILogger {
    if (!Logger.instance) {
      Logger.instance = new Logger(
        config?.enabled ?? false,
        config?.enabledLevels ?? []
      );
    }
    return Logger.instance;
  }

  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  public isLoggingEnabled(): boolean {
    return this.enabled;
  }

  public setEnabledLevels(levels: LogLevel[]): void {
    this.enabledLevels = new Set(levels);
  }

  public getEnabledLevels(): LogLevel[] {
    return Array.from(this.enabledLevels);
  }

  private shouldLog(level: LogLevel): boolean {
    if (!this.enabled) return false;
    return this.enabledLevels.has(level);
  }

  private formatMessage(message: string): string {
    const timestamp = new Date().toLocaleString("en-US", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    return `[Formo SDK][${timestamp}] ${message}`;
  }

  public debug(message: string, ...args: any[]): void {
    if (this.shouldLog("debug")) {
      console.debug(this.formatMessage(message), ...args);
    }
  }

  public info(message: string, ...args: any[]): void {
    if (this.shouldLog("info")) {
      console.info(this.formatMessage(message), ...args);
    }
  }

  public warn(message: string, ...args: any[]): void {
    if (this.shouldLog("warn")) {
      console.warn(this.formatMessage(message), ...args);
    }
  }

  public error(message: string, ...args: any[]): void {
    if (this.shouldLog("error")) {
      console.error(this.formatMessage(message), ...args);
    }
  }

  public trace(message: string, ...args: any[]): void {
    if (this.shouldLog("trace")) {
      console.trace(this.formatMessage(message), ...args);
    }
  }

  public log(message: string, ...args: any[]): void {
    this.info(message, ...args);
  }
}

// Export a default instance for easy use
export const logger = Logger.getInstance();
