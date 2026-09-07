import { AnonymousID } from "../types";
import { generateNativeUUID } from "../utils";
import { cookie, local, usesCookieStorage } from "../storage";
import {
  getIdentityCookieDomain,
  getIdentityCookieSecurity,
} from "../storage/cookiePolicy";

/** Page-lifetime fallback when persistent storage is unavailable. */
let volatileAnonymousId: AnonymousID | undefined;

/** Persistent fallback when cookies are unavailable. */
const readLocal = (key: string): string | undefined => {
  try {
    const value = local().get(key);
    return typeof value === "string" && value ? value : undefined;
  } catch {
    return undefined;
  }
};

const generateAnonymousId = (key: string, crossSubdomainCookies?: boolean): AnonymousID => {
  const storedAnonymousId = cookie().get(key);
  const anonymousId = (
    storedAnonymousId && typeof storedAnonymousId === "string"
      ? storedAnonymousId
      : readLocal(key) ?? volatileAnonymousId ?? generateNativeUUID()
  ) as AnonymousID;
  const domain = getIdentityCookieDomain(crossSubdomainCookies);
  // Re-set the cookie with the configured scope. When crossSubdomainCookies
  // is true, this migrates legacy host-only cookies on the current host to the apex
  // domain. Note: host-only cookies on other hosts (e.g. a cookie set on
  // example.com is not visible from app.example.com) cannot be migrated
  // until the user revisits that host.
  cookie().set(key, anonymousId, {
    expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toUTCString(), // 1 year
    path: "/",
    // Consistent with the other identity cookies: SameSite=Lax +
    // Secure (HTTPS only). Orthogonal to `domain` cross-subdomain
    // sharing and to JS document.cookie read/write.
    ...getIdentityCookieSecurity(),
    ...(domain ? { domain } : {}),
  });
  // Retry host-only when a domain-scoped write is rejected.
  if (domain && cookie().get(key) !== anonymousId) {
    cookie().set(key, anonymousId, {
      expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toUTCString(),
      path: "/",
      ...getIdentityCookieSecurity(),
    });
  }
  if (cookie().get(key) === anonymousId) {
    // Prefer the cookie and discard the fallback copy.
    volatileAnonymousId = undefined;
    if (usesCookieStorage() && readLocal(key)) {
      try {
        local().remove(key);
      } catch {
        // Storage is unavailable.
      }
    }
    return anonymousId;
  }
  // Persist across embedded page loads when cookies are blocked.
  try {
    local().set(key, anonymousId);
  } catch {
    // Memory remains the last fallback.
  }
  volatileAnonymousId = anonymousId;
  return anonymousId;
};

/** Clear the anonymous id from every storage layer. */
const clearAnonymousId = (key: string): void => {
  cookie().remove(key);
  try {
    local().remove(key);
  } catch {
    // Storage is unavailable.
  }
  volatileAnonymousId = undefined;
};

/** Test hook: forget the page-lifetime memory, as a new page load would. */
const __resetAnonymousIdMemory = (): void => {
  volatileAnonymousId = undefined;
};

export { generateAnonymousId, clearAnonymousId, __resetAnonymousIdMemory };
