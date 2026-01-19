import { STORAGE_PREFIX } from "../../constants";
import { IStorage } from "./types";

/**
 * Base storage class with key prefixing
 */
abstract class StorageBlueprint implements IStorage {
  protected writeKey: string;

  constructor(writeKey: string) {
    this.writeKey = writeKey;
  }

  /**
   * Generate storage key with prefix
   */
  public getKey(key: string): string {
    return `${STORAGE_PREFIX}${this.writeKey}_${key}`;
  }

  abstract isAvailable(): boolean;
  abstract get(key: string): string | null;
  abstract getAsync(key: string): Promise<string | null>;
  abstract set(key: string, value: string): void;
  abstract setAsync(key: string, value: string): Promise<void>;
  abstract remove(key: string): void;
  abstract removeAsync(key: string): Promise<void>;
}

export default StorageBlueprint;
