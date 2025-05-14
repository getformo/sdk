import { KEY_PREFIX } from "../constant";
import { CookieOptions, IStorage } from "../type";

abstract class StorageBlueprint implements IStorage {
  constructor(private readonly writeKey: string) {}

  abstract isAvailable(): boolean;
  abstract set(key: string, value: string, options?: CookieOptions): void;
  abstract get(key: string): any;
  abstract remove(key: string): void;

  protected getKey(key: string): string {
    return `${KEY_PREFIX}_${this.writeKey}.${key}`;
  }
}

export default StorageBlueprint;
