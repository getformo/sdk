import StorageBlueprint from "./StorageBlueprint";
import { AsyncStorageInterface } from "./types";
import { logger } from "../logger";

/**
 * AsyncStorage adapter for React Native
 * Provides persistent storage across app restarts
 */
class AsyncStorageAdapter extends StorageBlueprint {
  private asyncStorage: AsyncStorageInterface | null = null;
  private cache: Map<string, string> = new Map();
  private initialized: boolean = false;

  constructor(writeKey: string, asyncStorage?: AsyncStorageInterface) {
    super(writeKey);
    if (asyncStorage) {
      this.asyncStorage = asyncStorage;
    }
  }

  /**
   * Initialize with AsyncStorage instance
   */
  public async initialize(asyncStorage: AsyncStorageInterface): Promise<void> {
    this.asyncStorage = asyncStorage;
    this.initialized = true;
    logger.debug("AsyncStorageAdapter: Initialized");
  }

  public isAvailable(): boolean {
    return this.asyncStorage !== null;
  }

  /**
   * Synchronous get from cache (may return stale data)
   * Use getAsync for guaranteed fresh data
   */
  public get(key: string): string | null {
    const cachedValue = this.cache.get(this.getKey(key));
    if (cachedValue !== undefined) {
      return cachedValue;
    }

    // Trigger async fetch to populate cache
    this.getAsync(key).catch(() => {
      // Ignore errors in background fetch
    });

    return null;
  }

  /**
   * Async get from storage
   */
  public async getAsync(key: string): Promise<string | null> {
    if (!this.asyncStorage) {
      return this.cache.get(this.getKey(key)) ?? null;
    }

    try {
      const fullKey = this.getKey(key);
      const value = await this.asyncStorage.getItem(fullKey);

      if (value !== null) {
        this.cache.set(fullKey, value);
      }

      return value;
    } catch (error) {
      logger.error("AsyncStorageAdapter: Failed to get item", error);
      return this.cache.get(this.getKey(key)) ?? null;
    }
  }

  /**
   * Synchronous set (writes to cache immediately, persists async)
   */
  public set(key: string, value: string): void {
    const fullKey = this.getKey(key);
    this.cache.set(fullKey, value);

    // Persist asynchronously
    this.setAsync(key, value).catch((error) => {
      logger.error("AsyncStorageAdapter: Failed to persist item", error);
    });
  }

  /**
   * Async set to storage
   */
  public async setAsync(key: string, value: string): Promise<void> {
    const fullKey = this.getKey(key);
    this.cache.set(fullKey, value);

    if (!this.asyncStorage) {
      return;
    }

    try {
      await this.asyncStorage.setItem(fullKey, value);
    } catch (error) {
      logger.error("AsyncStorageAdapter: Failed to set item", error);
      throw error;
    }
  }

  /**
   * Synchronous remove (removes from cache immediately, persists async)
   */
  public remove(key: string): void {
    const fullKey = this.getKey(key);
    this.cache.delete(fullKey);

    // Persist asynchronously
    this.removeAsync(key).catch((error) => {
      logger.error("AsyncStorageAdapter: Failed to remove item", error);
    });
  }

  /**
   * Async remove from storage
   */
  public async removeAsync(key: string): Promise<void> {
    const fullKey = this.getKey(key);
    this.cache.delete(fullKey);

    if (!this.asyncStorage) {
      return;
    }

    try {
      await this.asyncStorage.removeItem(fullKey);
    } catch (error) {
      logger.error("AsyncStorageAdapter: Failed to remove item", error);
      throw error;
    }
  }

  /**
   * Clear all cached data
   */
  public clearCache(): void {
    this.cache.clear();
  }
}

export default AsyncStorageAdapter;
