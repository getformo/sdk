import { logger } from "../../logger";
import { JSON_PREFIX } from "../constant";
import StorageBlueprint from "./blueprint";

class WebStorage extends StorageBlueprint {
  constructor(writeKey: string, private readonly backend: Storage) {
    super(writeKey);
  }

  public override isAvailable(): boolean {
    try {
      const testKey = "__storage_test__";
      this.backend.setItem(testKey, "1");
      this.backend.removeItem(testKey);
      return true;
    } catch {
      return false;
    }
  }

  public override set(key: string, value: any): void {
    if (typeof value === "boolean") value = value === true ? "true" : "false";
    if (typeof value === "object") value = JSON_PREFIX + JSON.stringify(value);
    this.backend.setItem(this.getKey(key), value);
  }

  public override get(key: string): string | boolean | Record<any, any> | null {
    const value = this.backend.getItem(this.getKey(key));

    if (!value || typeof value !== "string") return null;
    if (["null", "undefined"].some((item) => item == value)) return null;

    if (value.startsWith(JSON_PREFIX)) {
      try {
        return JSON.parse(value.slice(JSON_PREFIX.length));
      } catch (error) {
        logger.error(
          `[FORMO_ERROR] ${this.backend.constructor.name} failed to parse JSON`,
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

  public override remove(key: string): void {
    this.backend.removeItem(this.getKey(key));
  }
}

export default WebStorage;
