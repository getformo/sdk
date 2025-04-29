import { IStorageKeyManager } from "./type";

class StorageKey implements IStorageKeyManager {
  private readonly prefix = "formo";
  private readonly writeKey: string;

  constructor(writeKey: string) {
    this.writeKey = writeKey;
  }

  getKey(name: string): string {
    return this.prefix + "_" + this.writeKey + "." + name;
  }
}

export { StorageKey };
