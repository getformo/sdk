import StorageBlueprint from "./StorageBlueprint";

/**
 * In-memory storage fallback
 * Data is lost when the app is closed
 */
class MemoryStorage extends StorageBlueprint {
  private storage: Map<string, string> = new Map();

  public isAvailable(): boolean {
    return true;
  }

  public get(key: string): string | null {
    return this.storage.get(this.getKey(key)) ?? null;
  }

  public async getAsync(key: string): Promise<string | null> {
    return this.get(key);
  }

  public set(key: string, value: string): void {
    this.storage.set(this.getKey(key), value);
  }

  public async setAsync(key: string, value: string): Promise<void> {
    this.set(key, value);
  }

  public remove(key: string): void {
    this.storage.delete(this.getKey(key));
  }

  public async removeAsync(key: string): Promise<void> {
    this.remove(key);
  }

  public clear(): void {
    this.storage.clear();
  }
}

export default MemoryStorage;
