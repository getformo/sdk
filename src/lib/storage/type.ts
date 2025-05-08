export interface IStorageKeyManager {
  getKey(name: string): string;
}

export type NativeStorageName = "sessionStorage" | "localStorage";
export type StorageName = NativeStorageName | "cookieStorage" | "memoryStorage";
export type CookieOptions = {
  maxAge?: number;
  expires?: string;
  path?: string;
  domain?: string;
  secure?: boolean;
  sameSite?: "lax" | "strict" | "none";
};

export interface IStorage {
  isAvailable(): boolean;
  set(key: string, value: string, options?: CookieOptions): void;
  get(key: string): string | null;
  remove(key: string): void;
  removeMatch(pattern: RegExp): void;
  clear(): void;
}
