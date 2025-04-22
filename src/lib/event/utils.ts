import { LOCAL_ANONYMOUS_ID_KEY } from "../../constants";
import { AnonymousID } from "../../types";
import { generateNativeUUID } from "../../utils";
import { local } from "../storage";

const generateAnonymousId = (): AnonymousID => {
  const storedAnonymousId = local.get(LOCAL_ANONYMOUS_ID_KEY);
  if (storedAnonymousId && typeof storedAnonymousId === "string")
    return storedAnonymousId as AnonymousID;
  const newAnonymousId = generateNativeUUID();
  local.set(LOCAL_ANONYMOUS_ID_KEY, newAnonymousId);
  return newAnonymousId;
};

export { generateAnonymousId };
