import { logger } from "../logger";

export class NativeStorage {
  private readonly json_prefix = "__json=";
  private readonly storageName: "sessionStorage" | "localStorage";
  private readonly storage: Storage;
  private readonly isBrowser: boolean;
  private memoryStorage: Record<string, string>;

  constructor(type: "sessionStorage" | "localStorage") {
    this.isBrowser = typeof window !== "undefined";
    this.memoryStorage = {};
    this.storageName = type;

    if (!this.isBrowser) {
      // Create an in-memory storage for SSR
      this.storage = {
        getItem: (key: string) => this.memoryStorage[key] || null,
        setItem: (key: string, value: string) => {
          this.memoryStorage[key] = value;
        },
        removeItem: (key: string) => {
          delete this.memoryStorage[key];
        },
        clear: () => {
          this.memoryStorage = {};
        },
        key: (index: number) => Object.keys(this.memoryStorage)[index] || null,
        length: 0,
      };
      return;
    }

    switch (type) {
      case "sessionStorage":
        this.storage = sessionStorage;
        break;
      case "localStorage":
        this.storage = localStorage;
        break;
    }
  }

  public isAvailable(): boolean {
    return this.isBrowser;
  }

  public set(key: string, value: any): void {
    if (typeof value === "boolean") value = value === true ? "true" : "false";
    if (typeof value === "object")
      value = this.json_prefix + JSON.stringify(value);
    this.storage.setItem(key, value);
  }

  public get(key: string): string | boolean | Record<any, any> | null {
    const value = this.storage.getItem(key);

    if (!value || typeof value !== "string") return null;
    if (["null", "undefined"].some((item) => item == value)) return null;

    if (value.startsWith(this.json_prefix)) {
      try {
        return JSON.parse(value.slice(7));
      } catch (error) {
        logger.error(
          `[FORMO_ERROR] ${this.storageName} failed to parse JSON`,
          error
        );
        return null;
      }
    }

    if (["true", "false"].some((item) => item == value)) {
      return JSON.parse(value);
    }

    return value;
  }

  public removeMatch(pattern: RegExp): void {
    for (const key in this.storage) {
      if (pattern.test(key)) {
        this.remove(key);
      }
    }
  }

  public remove(key: string): void {
    this.storage.removeItem(key);
  }

  public clear(): void {
    this.storage.clear();
  }
}

export default NativeStorage;
