export const SESSION_TRAFFIC_SOURCE_KEY = "traffic-source";
export const SESSION_WALLET_DETECTED_KEY = "wallet-detected";
export const SESSION_WALLET_IDENTIFIED_KEY = "wallet-identified";
export const SESSION_CURRENT_URL_KEY = "analytics-current-url";
export const SESSION_USER_ID_KEY = "user-id";

export const LOCAL_ANONYMOUS_ID_KEY = "anonymous-id";

// Consent management keys
export const CONSENT_OPT_OUT_KEY = "opt-out-tracking";

// Default provider icon (empty data URL)
export const DEFAULT_PROVIDER_ICON = 'data:image/svg+xml;base64,';

// Blocked addresses that should not emit events
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const DEAD_ADDRESS = "0x000000000000000000000000000000000000dEaD";

// Array of all blocked addresses for easy checking
export const BLOCKED_ADDRESSES = [ZERO_ADDRESS, DEAD_ADDRESS] as const;

