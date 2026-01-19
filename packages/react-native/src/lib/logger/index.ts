export type LogLevel = "debug" | "info" | "warn" | "error" | "log";

interface LoggerConfig {
  enabled?: boolean;
  enabledLevels?: LogLevel[];
}

class LoggerClass {
  private config: LoggerConfig = {
    enabled: false,
    enabledLevels: [],
  };

  init(config: LoggerConfig) {
    this.config = config;
  }

  private shouldLog(level: LogLevel): boolean {
    if (!this.config.enabled) return false;
    if (this.config.enabledLevels?.length === 0) return true;
    return this.config.enabledLevels?.includes(level) ?? false;
  }

  debug(...args: unknown[]) {
    if (this.shouldLog("debug")) {
      console.debug("[Formo RN]", ...args);
    }
  }

  info(...args: unknown[]) {
    if (this.shouldLog("info")) {
      console.info("[Formo RN]", ...args);
    }
  }

  warn(...args: unknown[]) {
    if (this.shouldLog("warn")) {
      console.warn("[Formo RN]", ...args);
    }
  }

  error(...args: unknown[]) {
    if (this.shouldLog("error")) {
      console.error("[Formo RN]", ...args);
    }
  }

  log(...args: unknown[]) {
    if (this.shouldLog("log")) {
      console.log("[Formo RN]", ...args);
    }
  }
}

export const Logger = new LoggerClass();
export const logger = Logger;
