import { KEY_PREFIX } from "../constant";
import { CookieOptions } from "../type";

abstract class StorageBlueprint {
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
