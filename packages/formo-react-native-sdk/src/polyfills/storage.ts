/**
 * Storage polyfill for React Native
 *
 * Provides a localStorage-compatible interface using AsyncStorage
 * with consistent prefixing for all Formo data
 */

import { AsyncStorageInterface } from "../lib/storage/types";

const FORMO_PREFIX = "@formo:";

// In-memory cache for synchronous access
let memoryCache: Map<string, string> = new Map();
let asyncStorage: AsyncStorageInterface | null = null;
let isInitialized = false;

/**
 * Add Formo prefix to key for storage isolation
 */
function getPrefixedKey(key: string): string {
  // If key already has prefix, don't double-prefix
  if (key.startsWith(FORMO_PREFIX)) {
    return key;
  }
  return `${FORMO_PREFIX}${key}`;
}

/**
 * Remove Formo prefix from key
 */
function getUnprefixedKey(key: string): string {
  if (key.startsWith(FORMO_PREFIX)) {
    return key.slice(FORMO_PREFIX.length);
  }
  return key;
}

/**
 * Load all Formo-prefixed data from AsyncStorage into memory cache
 */
export async function loadFromAsyncStorage(
  storage: AsyncStorageInterface
): Promise<void> {
  asyncStorage = storage;

  try {
    const keys = await asyncStorage.getAllKeys();
    // Only load keys that have our prefix
    const formoKeys = keys.filter((key) => key.startsWith(FORMO_PREFIX));

    if (formoKeys.length > 0) {
      const pairs = await asyncStorage.multiGet(formoKeys);

      for (const [key, value] of pairs) {
        if (value !== null) {
          // Store with the full prefixed key in memory cache
          memoryCache.set(key, value);
        }
      }
    }

    isInitialized = true;
  } catch (err) {
    console.warn("[Formo] Failed to load from AsyncStorage:", err);
    isInitialized = true;
  }
}

/**
 * localStorage-compatible polyfill for React Native
 *
 * All keys are automatically prefixed with @formo: to:
 * 1. Isolate Formo data from other app data
 * 2. Ensure consistent load/save behavior
 * 3. Allow safe clear() without affecting other app data
 */
export const localStoragePolyfill = {
  getItem(key: string): string | null {
    const prefixedKey = getPrefixedKey(key);
    return memoryCache.get(prefixedKey) ?? null;
  },

  setItem(key: string, value: string): void {
    const prefixedKey = getPrefixedKey(key);

    // Update memory cache immediately for synchronous access
    memoryCache.set(prefixedKey, value);

    // Persist to AsyncStorage asynchronously
    asyncStorage?.setItem(prefixedKey, value).catch((err) => {
      console.warn("[Formo] Failed to save to AsyncStorage:", err);
    });
  },

  removeItem(key: string): void {
    const prefixedKey = getPrefixedKey(key);

    // Remove from memory cache immediately
    memoryCache.delete(prefixedKey);

    // Remove from AsyncStorage asynchronously
    asyncStorage?.removeItem(prefixedKey).catch((err) => {
      console.warn("[Formo] Failed to remove from AsyncStorage:", err);
    });
  },

  /**
   * Clear only Formo data, not the entire AsyncStorage
   *
   * Unlike web localStorage which is origin-isolated, React Native's
   * AsyncStorage is shared across the entire app. We only clear our
   * prefixed keys to avoid corrupting other app data.
   */
  clear(): void {
    // Get all Formo keys from memory cache
    const formoKeys = Array.from(memoryCache.keys()).filter((key) =>
      key.startsWith(FORMO_PREFIX)
    );

    // Clear from memory cache
    for (const key of formoKeys) {
      memoryCache.delete(key);
    }

    // Clear from AsyncStorage (only Formo keys)
    if (asyncStorage && formoKeys.length > 0) {
      asyncStorage.multiRemove(formoKeys).catch((err) => {
        console.warn("[Formo] Failed to clear Formo data from AsyncStorage:", err);
      });
    }
  },

  /**
   * Get the number of Formo items in storage
   */
  get length(): number {
    return Array.from(memoryCache.keys()).filter((key) =>
      key.startsWith(FORMO_PREFIX)
    ).length;
  },

  /**
   * Get key at index (only Formo keys)
   */
  key(index: number): string | null {
    const formoKeys = Array.from(memoryCache.keys()).filter((key) =>
      key.startsWith(FORMO_PREFIX)
    );
    const prefixedKey = formoKeys[index];
    return prefixedKey ? getUnprefixedKey(prefixedKey) : null;
  },
};

/**
 * Check if storage is initialized
 */
export function isStorageInitialized(): boolean {
  return isInitialized;
}

/**
 * Reset storage state (for testing)
 */
export function resetStorage(): void {
  memoryCache = new Map();
  asyncStorage = null;
  isInitialized = false;
}

export default localStoragePolyfill;
