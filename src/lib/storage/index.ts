import { IStorage, StorageType } from "./type";
import { StorageManager } from "./StorageManager";
export * from "./type";

let globalManager: StorageManager | null = null;
let consentAwareMode = false;
let forcedStorageType: StorageType | null = null;

export function initStorageManager(writeKey: string): void {
  if (!globalManager) {
    globalManager = new StorageManager(writeKey);
  }
}

/**
 * Enable consent-aware storage mode
 * @param hasConsent - Whether the user has given consent for persistent storage
 */
export function setConsentAwareStorage(hasConsent: boolean): void {
  consentAwareMode = true;
  forcedStorageType = hasConsent ? null : "memoryStorage";
}

/**
 * Disable consent-aware storage mode (returns to normal fallback behavior)
 */
export function disableConsentAwareStorage(): void {
  consentAwareMode = false;
  forcedStorageType = null;
}

function getStorageInstance(type: StorageType): IStorage {
  if (!globalManager) {
    throw new Error(
      "StorageManager not initialized. Call initStorageManager(writeKey) first."
    );
  }
  
  // If consent-aware mode is enabled and we have a forced storage type, use it
  if (consentAwareMode && forcedStorageType) {
    return globalManager.getStorage(forcedStorageType);
  }
  
  return globalManager.getStorage(type);
}

export const cookie = () => getStorageInstance("cookieStorage");
export const local = () => getStorageInstance("localStorage");
export const session = () => getStorageInstance("sessionStorage");
export const memory = () => getStorageInstance("memoryStorage");
