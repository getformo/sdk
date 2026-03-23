import { AnonymousID } from "../types";
import { generateNativeUUID } from "../utils";
import { cookie } from "../storage";

const generateAnonymousId = (key: string): AnonymousID => {
  const storedAnonymousId = cookie().get(key);
  if (storedAnonymousId && typeof storedAnonymousId === "string")
    return storedAnonymousId as AnonymousID;
  const newAnonymousId = generateNativeUUID();
  cookie().set(key, newAnonymousId, {
    maxAge: Date.now() + 1000 * 60 * 60 * 24 * 365, // 1 year
    path: "/",
  });
  return newAnonymousId;
};

export { generateAnonymousId };
