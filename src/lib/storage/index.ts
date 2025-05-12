import { IStorage, StorageType } from "./type";
import { StorageManager } from "./StorageManager";
export * from "./type";

let globalManager: StorageManager | null = null;

export function initStorageManager(writeKey: string): void {
  if (!globalManager) {
    globalManager = new StorageManager(writeKey);
  }
}

function getStorageInstance(type: StorageType): IStorage {
  if (!globalManager) {
    throw new Error(
      "StorageManager not initialized. Call initStorageManager(writeKey) first."
    );
  }
  return globalManager.getStorage(type);
}

export const cookie = () => getStorageInstance("cookieStorage");
export const local = () => getStorageInstance("localStorage");
export const session = () => getStorageInstance("sessionStorage");
export const memory = () => getStorageInstance("memoryStorage");
