import { AnonymousID } from "../types";
import { generateNativeUUID } from "../utils";
import { cookie } from "../storage";
import { getIdentityCookieDomain } from "../storage/cookiePolicy";

const generateAnonymousId = (key: string, cookieScope?: 'host' | 'apex'): AnonymousID => {
  const storedAnonymousId = cookie().get(key);
  const anonymousId = (
    storedAnonymousId && typeof storedAnonymousId === "string"
      ? storedAnonymousId
      : generateNativeUUID()
  ) as AnonymousID;
  const domain = getIdentityCookieDomain(cookieScope);
  // Re-set the cookie with the configured scope. When cookieScope is 'apex',
  // this migrates legacy host-only cookies on the current host to the apex
  // domain. Note: host-only cookies on other hosts (e.g. a cookie set on
  // example.com is not visible from app.example.com) cannot be migrated
  // until the user revisits that host.
  cookie().set(key, anonymousId, {
    maxAge: Date.now() + 1000 * 60 * 60 * 24 * 365, // 1 year
    path: "/",
    ...(domain ? { domain } : {}),
  });
  return anonymousId;
};

export { generateAnonymousId };
