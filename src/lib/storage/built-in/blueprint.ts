import { KEY_PREFIX } from "../constant";
import { CookieOptions, IStorage } from "../type";
import { secureHash } from "../../../utils/hash";

abstract class StorageBlueprint implements IStorage {
  constructor(private readonly writeKey: string) {}

  abstract isAvailable(): boolean;
  abstract set(key: string, value: string, options?: CookieOptions): void;
  abstract get(key: string): any;
  abstract remove(key: string): void;

  protected getKey(key: string): string {
    // Use SHA-256 hashed writeKey for privacy and security
    const hashedWriteKey = secureHash(this.writeKey);
    return `${KEY_PREFIX}_${hashedWriteKey}_${key}`;
  }
}

export default StorageBlueprint;
