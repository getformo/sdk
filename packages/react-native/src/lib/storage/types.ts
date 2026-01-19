export type StorageType = "asyncStorage" | "memoryStorage";

export interface IStorage {
  isAvailable(): boolean;
  get(key: string): string | null;
  getAsync(key: string): Promise<string | null>;
  set(key: string, value: string): void;
  setAsync(key: string, value: string): Promise<void>;
  remove(key: string): void;
  removeAsync(key: string): Promise<void>;
  getKey(key: string): string;
}

export interface AsyncStorageInterface {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  multiGet?(keys: string[]): Promise<readonly [string, string | null][]>;
  multiSet?(keyValuePairs: [string, string][]): Promise<void>;
  multiRemove?(keys: string[]): Promise<void>;
}
