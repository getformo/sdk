import StorageBlueprint from "./blueprint";
import { CookieOptions } from "../type";

class CookieStorage extends StorageBlueprint {
  public override isAvailable(): boolean {
    return (
      typeof document !== "undefined" && typeof document.cookie === "string"
    );
  }

  public override set(
    key: string,
    value: string,
    options?: CookieOptions
  ): void {
    const expires = options?.expires;
    const maxAge = options?.maxAge;
    const path = options?.path || "/";
    const domain = options?.domain;
    const sameSite = options?.sameSite;
    const secure = options?.secure || false;

    let cookie = `${encodeURIComponent(this.getKey(key))}=${encodeURIComponent(
      value
    )}`;
    if (maxAge) {
      cookie += "; max-age=" + maxAge;
    } else if (expires) {
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

  public override get(key: string): string | null {
    const match = document.cookie.match(
      new RegExp(`(?:^|; )${encodeURIComponent(this.getKey(key))}=([^;]*)`)
    );
    return match ? decodeURIComponent(match[1]) : null;
  }

  public override remove(key: string): void {
    document.cookie = `${encodeURIComponent(
      this.getKey(key)
    )}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  }
}

export default CookieStorage;
