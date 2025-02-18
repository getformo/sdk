export class SessionStorage {
  private readonly json_prefix = "__json=";

  public setItem(key: string, value: any): void {
    if (typeof value === "boolean") value = value === true ? "true" : "false";
    if (typeof value === "object")
      value = this.json_prefix + JSON.stringify(value);
    sessionStorage.setItem(key, value);
  }

  public getItem(key: string): string | boolean | Record<any, any> | null {
    const value = sessionStorage.getItem(key);

    if (!value || typeof value !== "string") return null;
    if (["null", "undefined"].some((item) => item == value)) return null;

    if (value.startsWith(this.json_prefix)) {
      try {
        return JSON.parse(value.slice(7));
      } catch (error) {
        console.error(
          "[FORMO_ERROR] SessionStorage failed to parse JSON",
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
    for (const key in sessionStorage) {
      if (pattern.test(key)) {
        this.removeItem(key);
      }
    }
  }

  public removeItem(key: string): void {
    sessionStorage.removeItem(key);
  }

  public clear(): void {
    sessionStorage.clear();
  }
}

export default new SessionStorage();
