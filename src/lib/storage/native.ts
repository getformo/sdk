import { logger } from "../logger";
import {
  CookieOptions,
  IStorage,
  NativeStorageName,
  StorageName,
} from "./type";

//#region Native Storage
class NativeStorage {
  private readonly json_prefix = "__json=";
  private readonly storageName: NativeStorageName;
  private readonly storage: Storage;

  constructor(type: NativeStorageName) {
    this.storageName = type;

    switch (type) {
      case "sessionStorage":
        this.storage = sessionStorage;
        break;
      case "localStorage":
        this.storage = localStorage;
        break;
    }
  }

  static isAvailable(type: NativeStorageName): boolean {
    if (!window) return false;
    return type === "sessionStorage"
      ? typeof window.sessionStorage !== "undefined"
      : typeof window.localStorage !== "undefined";
  }

  public set(key: string, value: any): void {
    if (typeof value === "boolean") value = value === true ? "true" : "false";
    if (typeof value === "object")
      value = this.json_prefix + JSON.stringify(value);
    this.storage.setItem(key, value);
  }

  public get(key: string): string | boolean | Record<any, any> | null {
    const value = this.storage.getItem(key);

    if (!value || typeof value !== "string") return null;
    if (["null", "undefined"].some((item) => item == value)) return null;

    if (value.startsWith(this.json_prefix)) {
      try {
        return JSON.parse(value.slice(this.json_prefix.length));
      } catch (error) {
        logger.error(
          `[FORMO_ERROR] ${this.storageName} failed to parse JSON`,
          error
        );
        return null;
      }
    }

    if (["true", "false"].some((item) => item == value)) {
      return JSON.parse(value);
    }

    return value;
  }

  public removeMatch(pattern: RegExp): void {
    for (const key in this.storage) {
      if (pattern.test(key)) {
        this.remove(key);
      }
    }
  }

  public remove(key: string): void {
    this.storage.removeItem(key);
  }

  public clear(): void {
    this.storage.clear();
  }
}
//#region Cookie Storage
class CookieStorage {
  static isAvailable(): boolean {
    return (
      typeof document !== "undefined" && typeof document.cookie !== "undefined"
    );
  }

  public set(key: string, value: string, options?: CookieOptions): void {
    const expires = options?.expires;
    const maxAge = options?.maxAge;
    const path = options?.path || "/";
    const domain = options?.domain;
    const sameSite = options?.sameSite;
    const secure = options?.secure || false;

    let cookie = key + "=" + value;
    if (maxAge) {
      cookie += "; max-age=" + maxAge;
    }
    if (expires) {
      cookie += "; expires=" + expires;
    }
    if (path) {
      cookie += "; path=" + path;
    }
    if (domain) {
      cookie += "; domain=" + domain;
    }
    if (sameSite) {
      cookie += "; samesite=" + sameSite;
    }
    if (secure) {
      cookie += "; secure";
    }
    document.cookie = cookie;
  }

  public get(key: string): string | null {
    const cookie = document.cookie;
    const matches = cookie.match(new RegExp(key + "=([^;]+)"));
    return matches ? matches[1] : null;
  }

  public remove(key: string): void {
    document.cookie = key + "=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/";
  }

  public removeMatch(pattern: RegExp): void {
    const cookies = document.cookie.split(";");
    const keys = cookies.map((cookie) => cookie.split("=")[0]);
    for (const key of keys) {
      if (pattern.test(key)) {
        this.remove(key);
      }
    }
  }

  public clear(): void {
    document.cookie = "";
  }
}
//#region Memory Storage
class MemoryStorage {
  private memoryStorage: Record<string, string>;

  constructor() {
    this.memoryStorage = {};
  }

  public static isAvailable(): boolean {
    return true;
  }

  public set(key: string, value: string): void {
    this.memoryStorage[key] = value;
  }

  public get(key: string): string | null {
    return this.memoryStorage[key] || null;
  }

  public remove(key: string): void {
    delete this.memoryStorage[key];
  }

  public removeMatch(pattern: RegExp): void {
    for (const key in this.memoryStorage) {
      if (pattern.test(key)) {
        this.remove(key);
      }
    }
  }

  public clear(): void {
    this.memoryStorage = {};
  }
}

class CombinedStorage implements IStorage {
  private readonly storageName: StorageName;
  private readonly storage;

  constructor(type: StorageName) {
    this.storageName = type;

    // Storage fallback
    if (this.storageName === "cookieStorage" && !CookieStorage.isAvailable()) {
      this.storageName = "localStorage";
    }
    if (
      this.storageName === "localStorage" &&
      !NativeStorage.isAvailable("localStorage")
    ) {
      this.storageName = "sessionStorage";
    }
    if (
      this.storageName === "sessionStorage" &&
      !NativeStorage.isAvailable("sessionStorage")
    ) {
      this.storageName = "memoryStorage";
    }

    switch (this.storageName) {
      case "sessionStorage":
        this.storage = new NativeStorage("sessionStorage");
        break;
      case "localStorage":
        this.storage = new NativeStorage("localStorage");
        break;
      case "cookieStorage":
        this.storage = new CookieStorage();
        break;
      case "memoryStorage":
        this.storage = new MemoryStorage();
        break;
    }
  }

  public isAvailable(): boolean {
    if (this.storageName === "memoryStorage") {
      return MemoryStorage.isAvailable();
    }
    if (this.storageName === "cookieStorage") {
      return CookieStorage.isAvailable();
    }
    return NativeStorage.isAvailable(this.storageName as NativeStorageName);
  }

  public set(key: string, value: any, options?: CookieOptions): void {
    this.storage.set(key, value, options);
  }

  public get(key: string): any {
    return this.storage.get(key);
  }

  public removeMatch(pattern: RegExp): void {
    this.storage.removeMatch(pattern);
  }

  public remove(key: string): void {
    this.storage.remove(key);
  }

  public clear(): void {
    this.storage.clear();
  }
}

export default CombinedStorage;
