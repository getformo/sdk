export type StorageType =
  | "cookieStorage"
  | "localStorage"
  | "sessionStorage"
  | "memoryStorage";

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
  get(key: string): any;
  remove(key: string): void;
}
