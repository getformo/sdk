import StorageBlueprint from "./blueprint";
import { CookieOptions } from "../type";
import { getApexDomain } from "../../utils/domain";

class CookieStorage extends StorageBlueprint {
  public override isAvailable(): boolean {
    return (
      typeof document !== "undefined" && typeof document.cookie === "string"
    );
  }

  private getDomainAttribute(): string {
    const domain = getApexDomain();
    return domain ? `.${domain}` : "";
  }

  public override set(
    key: string,
    value: string,
    options?: CookieOptions
  ): void {
    const expires = options?.expires;
    const maxAge = options?.maxAge;
    const path = options?.path || "/";
    const domain = options?.domain ?? this.getDomainAttribute();
    const sameSite = options?.sameSite;
    const secure = options?.secure || false;

    const encodedKey = encodeURIComponent(this.getKey(key));

    // Expire any legacy host-only cookie on the current host so it
    // doesn't shadow the domain-wide cookie in document.cookie reads.
    // This only clears the cookie on the current host; host-only cookies
    // on sibling hosts are not visible and cannot be cleared from here.
    if (domain) {
      document.cookie = `${encodedKey}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=${path};`;
    }

    let cookie = `${encodedKey}=${encodeURIComponent(value)}`;
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
    const encodedKey = encodeURIComponent(this.getKey(key));
    // Expire both host-only (current host only) and domain-wide cookies.
    // Cannot clear host-only cookies written on a different host.
    document.cookie = `${encodedKey}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
    const domain = this.getDomainAttribute();
    if (domain) {
      document.cookie = `${encodedKey}=; path=/; domain=${domain}; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
    }
  }
}

export default CookieStorage;
