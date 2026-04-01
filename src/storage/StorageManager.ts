import { logger } from "../logger";
import CookieStorage from "./built-in/cookie";
import MemoryStorage from "./built-in/memory";
import WebStorage from "./built-in/web";
import { IStorage, StorageType } from "./type";

// Fallback as follows: cookieStorage, localStorage, sessionStorage, memoryStorage
const TYPES: StorageType[] = [
  "cookieStorage",
  "localStorage",
  "sessionStorage",
  "memoryStorage",
];

export class StorageManager {
  private storages: Map<StorageType, IStorage> = new Map();

  constructor(private readonly writeKey: string) {}

  getStorage(type: StorageType): IStorage {
    if (!this.storages.has(type)) {
      let storage = this.createStorage(type);
      let currentType = type;
      // If storage is not available, try next
      while (!storage.isAvailable()) {
        const index = TYPES.indexOf(currentType);
        if (index === -1 || index + 1 >= TYPES.length) {
          // No more fallbacks, use memory storage as last resort
          storage = this.createStorage("memoryStorage");
          break;
        }
        const prevType = currentType;
        currentType = TYPES[index + 1];
        logger.warn(
          `Storage ${prevType} is not available, trying ${currentType}`
        );
        storage = this.createStorage(currentType);
      }

      // Add to cache
      this.storages.set(type, storage);
    }
    return this.storages.get(type)!;
  }

  private createStorage(type: StorageType): IStorage {
    switch (type) {
      case "cookieStorage":
        return new CookieStorage(this.writeKey);
      case "localStorage":
      case "sessionStorage": {
        const backend = this.getWebStorage(type);
        if (backend) {
          return new WebStorage(this.writeKey, backend);
        }
        return new MemoryStorage(this.writeKey);
      }
      case "memoryStorage":
      default:
        return new MemoryStorage(this.writeKey);
    }
  }

  private getWebStorage(
    type: "localStorage" | "sessionStorage"
  ): Storage | null {
    try {
      const storage = type === "localStorage" ? localStorage : sessionStorage;
      return storage ?? null;
    } catch {
      return null;
    }
  }
}
