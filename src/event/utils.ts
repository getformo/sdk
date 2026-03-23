import { AnonymousID } from "../types";
import { generateNativeUUID } from "../utils";
import { cookie } from "../storage";

const generateAnonymousId = (key: string): AnonymousID => {
  const storedAnonymousId = cookie().get(key);
  const anonymousId = (
    storedAnonymousId && typeof storedAnonymousId === "string"
      ? storedAnonymousId
      : generateNativeUUID()
  ) as AnonymousID;
  // Always re-set to ensure the cookie is domain-wide. This migrates
  // legacy host-only cookies on the current host to the apex domain.
  // Note: host-only cookies on other hosts (e.g. a cookie set on
  // example.com is not visible from app.example.com) cannot be migrated
  // until the user revisits that host. During this window, sibling
  // subdomains may mint a separate anonymous ID.
  cookie().set(key, anonymousId, {
    maxAge: Date.now() + 1000 * 60 * 60 * 24 * 365, // 1 year
    path: "/",
  });
  return anonymousId;
};

export { generateAnonymousId };
