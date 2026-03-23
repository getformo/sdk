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
        currentType = TYPES[index + 1];
        logger.warn(
          `Storage ${type} is not available, trying ${currentType}`
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
        return new WebStorage(this.writeKey, localStorage);
      case "sessionStorage":
        return new WebStorage(this.writeKey, sessionStorage);
      case "memoryStorage":
      default:
        return new MemoryStorage(this.writeKey);
    }
  }
}
