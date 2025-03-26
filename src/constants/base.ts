const STORAGE_PREFIX = "formo-";

const generateStoragePrefix = (prefix: string) => `${STORAGE_PREFIX}${prefix}`;

export const SESSION_IDENTIFIED_KEY =
  generateStoragePrefix("session-identified");
export const SESSION_CURRENT_URL_KEY = generateStoragePrefix(
  "analytics-current-url"
);
export const SESSION_USER_ID_KEY = generateStoragePrefix("user-id");

export const LOCAL_ANONYMOUS_ID_KEY = generateStoragePrefix("anonymous-id");
