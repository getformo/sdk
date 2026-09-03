import { AnonymousID } from "../types";
import { generateNativeUUID } from "../utils";
import { cookie, local } from "../storage";
import {
  getIdentityCookieDomain,
  getIdentityCookieSecurity,
} from "../storage/cookiePolicy";

/**
 * The anonymous id held for this page lifetime when the cookie write does not
 * stick. Browsers reject the write in a few contexts: a cross-site iframe
 * (SameSite=Lax is refused there), cookies blocked by policy, or a partitioned
 * third-party context. Without this, every event would mint a fresh id and
 * one session would look like hundreds of visitors.
 */
let volatileAnonymousId: AnonymousID | undefined;
// Module-level on purpose: the storage manager is keyed once per page
// (`initStorageManager` no-ops after the first call), so every instance on
// the page shares one cookie key and therefore one browser id.

/**
 * The rung between the cookie and memory. Where the cookie is refused
 * (a cross-site iframe, cookies blocked) Web Storage is partitioned by the
 * embedding site but survives reloads, so an embedded visitor stays one
 * visitor per embedding site instead of one per page load.
 */
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
  // Read back. A rejected domain-scoped write leaves nothing to read (and
  // set() has already expired any host-only cookie), so retry host-only
  // before giving up on persistence.
  if (domain && cookie().get(key) !== anonymousId) {
    cookie().set(key, anonymousId, {
      expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toUTCString(),
      path: "/",
      ...getIdentityCookieSecurity(),
    });
  }
  if (cookie().get(key) === anonymousId) {
    // The cookie is the source of truth again; a stale fallback copy would
    // otherwise resurface the moment a cookie expires.
    volatileAnonymousId = undefined;
    if (readLocal(key)) {
      try {
        local().remove(key);
      } catch {
        // Nothing to do: the copy is only ever read when the cookie misses.
      }
    }
    return anonymousId;
  }
  // Still nothing (cross-site iframe, cookies blocked): persist to Web
  // Storage for the next load and keep the id in memory for this one.
  try {
    local().set(key, anonymousId);
  } catch {
    // Storage refused too (sandboxed frame, quota); memory is the last rung.
  }
  volatileAnonymousId = anonymousId;
  return anonymousId;
};

/**
 * Forget the anonymous id everywhere: the cookie and the in-memory fallback.
 * The next event mints a new one. Reserved for consent withdrawal; a plain
 * `reset()` keeps the anonymous id because it identifies the browser, not
 * the user, and dropping it turns one visitor into many.
 */
const clearAnonymousId = (key: string): void => {
  cookie().remove(key);
  try {
    local().remove(key);
  } catch {
    // Storage refused; there is nothing of ours in it then.
  }
  volatileAnonymousId = undefined;
};

/** Test hook: forget the page-lifetime memory, as a new page load would. */
const __resetAnonymousIdMemory = (): void => {
  volatileAnonymousId = undefined;
};

export { generateAnonymousId, clearAnonymousId, __resetAnonymousIdMemory };
