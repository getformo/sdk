import { AnonymousID } from "../../types";
import { generateNativeUUID } from "../../utils";
import { local } from "../storage";

const generateAnonymousId = (key: string): AnonymousID => {
  const storedAnonymousId = local.get(key);
  if (storedAnonymousId && typeof storedAnonymousId === "string")
    return storedAnonymousId as AnonymousID;
  const newAnonymousId = generateNativeUUID();
  local.set(key, newAnonymousId);
  return newAnonymousId;
};

export { generateAnonymousId };
