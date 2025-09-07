export const SESSION_TRAFFIC_SOURCE_KEY = "traffic-source";
export const SESSION_WALLET_DETECTED_KEY = "wallet-detected";
export const SESSION_WALLET_IDENTIFIED_KEY = "wallet-identified";
export const SESSION_CURRENT_URL_KEY = "analytics-current-url";
export const SESSION_USER_ID_KEY = "user-id";

export const LOCAL_ANONYMOUS_ID_KEY = "anonymous-id";

// Consent management keys
export const CONSENT_OPT_OUT_KEY = "opt-out-tracking";
export const CONSENT_PREFERENCES_KEY = "consent-preferences";

// Default provider icon (empty data URL)
export const DEFAULT_PROVIDER_ICON = 'data:image/svg+xml;base64,';

// IP Address validation patterns
export const IPV4_PATTERN = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;

// IPv6 address patterns - broken down for readability and maintainability
const IPV6_FULL = /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/; // Full 8 groups
const IPV6_LOOPBACK = /^::1$/; // Loopback address
const IPV6_ALL_ZEROS = /^::$/; // All zeros address
const IPV6_LEADING_COMPRESSED = /^(?:[0-9a-fA-F]{1,4}:){1,7}:$/; // Leading groups with trailing compression
const IPV6_TRAILING_COMPRESSED = /^:(?:[0-9a-fA-F]{1,4}:){1,7}$/; // Trailing groups with leading compression
const IPV6_MIXED_1 = /^(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}$/; // 6 groups + 1 group
const IPV6_MIXED_2 = /^(?:[0-9a-fA-F]{1,4}:){1,5}(?::[0-9a-fA-F]{1,4}){1,2}$/; // 5 groups + 2 groups
const IPV6_MIXED_3 = /^(?:[0-9a-fA-F]{1,4}:){1,4}(?::[0-9a-fA-F]{1,4}){1,3}$/; // 4 groups + 3 groups
const IPV6_MIXED_4 = /^(?:[0-9a-fA-F]{1,4}:){1,3}(?::[0-9a-fA-F]{1,4}){1,4}$/; // 3 groups + 4 groups
const IPV6_MIXED_5 = /^(?:[0-9a-fA-F]{1,4}:){1,2}(?::[0-9a-fA-F]{1,4}){1,5}$/; // 2 groups + 5 groups
const IPV6_MIXED_6 = /^[0-9a-fA-F]{1,4}:(?::[0-9a-fA-F]{1,4}){1,6}$/; // 1 group + 6 groups

// Combined IPv6 pattern - more maintainable than a single complex regex
export const IPV6_PATTERN = new RegExp([
  IPV6_FULL.source,
  IPV6_LOOPBACK.source,
  IPV6_ALL_ZEROS.source,
  IPV6_LEADING_COMPRESSED.source,
  IPV6_TRAILING_COMPRESSED.source,
  IPV6_MIXED_1.source,
  IPV6_MIXED_2.source,
  IPV6_MIXED_3.source,
  IPV6_MIXED_4.source,
  IPV6_MIXED_5.source,
  IPV6_MIXED_6.source
].join('|'));
