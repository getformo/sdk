import StorageBlueprint from "./blueprint";

class MemoryStorage extends StorageBlueprint {
  private memoryStorage: Record<string, string> = {};

  public override isAvailable(): boolean {
    return true;
  }

  public override set(key: string, value: string): void {
    this.memoryStorage[this.getKey(key)] = value;
  }

  public override get(key: string): string | null {
    return this.memoryStorage[this.getKey(key)] || null;
  }

  public override remove(key: string): void {
    delete this.memoryStorage[this.getKey(key)];
  }
}

export default MemoryStorage;
