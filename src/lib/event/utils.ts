import { AnonymousID } from "../../types";
import { generateNativeUUID } from "../../utils";
import { cookie } from "../storage";

const generateAnonymousId = (key: string): AnonymousID => {
  const storedAnonymousId = cookie().get(key);
  if (storedAnonymousId && typeof storedAnonymousId === "string")
    return storedAnonymousId as AnonymousID;
  const newAnonymousId = generateNativeUUID();
  cookie().set(key, newAnonymousId, {
    maxAge: Date.now() + 1000 * 60 * 60 * 24 * 365, // 1 year
    domain: getCookieDomain(),
    path: "/",
  });
  return newAnonymousId;
};

function getCookieDomain(hostname: string = window.location.hostname): string {
  // Special cases
  if (hostname === "localhost" || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    // Localhost or IP address
    return "";
  }

  const parts = hostname.split(".");
  if (parts.length >= 2) {
    return `.${parts.slice(-2).join(".")}`; // e.g. example.com
  }

  return "";
}

export { generateAnonymousId, getCookieDomain };
