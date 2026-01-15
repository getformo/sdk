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
      // If storage is not available, try next
      while (!storage.isAvailable()) {
        const index = TYPES.indexOf(type);
        logger.warn(
          `Storage ${type} is not available, trying ${TYPES[index + 1]}`
        );
        storage = this.createStorage(TYPES[index + 1]);
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
