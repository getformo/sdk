const STORAGE_PREFIX = "formo-";

const generateStoragePrefix = (prefix: string) => `${STORAGE_PREFIX}${prefix}`;

export const SESSION_WALLET_DETECTED_KEY = generateStoragePrefix(
  "session-wallet-detected"
);
export const SESSION_CURRENT_URL_KEY = generateStoragePrefix(
  "analytics-current-url"
);
export const SESSION_USER_ID_KEY = generateStoragePrefix("user-id");

export const LOCAL_ANONYMOUS_ID_KEY = generateStoragePrefix("anonymous-id");

// SDK version - update this when releasing a new version
export const SDK_VERSION = "2.0.0";
