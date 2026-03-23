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
  // legacy host-only cookies to the apex domain on the next page load.
  cookie().set(key, anonymousId, {
    maxAge: Date.now() + 1000 * 60 * 60 * 24 * 365, // 1 year
    path: "/",
  });
  return anonymousId;
};

export { generateAnonymousId };
