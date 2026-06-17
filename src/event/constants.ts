const CHANNEL = "web";
const VERSION = "0";

/**
 * Paid-attribution click IDs captured from the landing-page URL and persisted
 * across the session alongside UTM parameters. Keep the ClickIdParameters type
 * in src/types/events.ts derived from this array.
 */
const CLICK_ID_PARAMS = [
  "gclid",      // Google Ads
  "gad_source", // Google Ads (newer)
  "fbclid",     // Meta (Facebook/Instagram)
  "msclkid",    // Microsoft Ads (Bing)
  "twclid",     // Twitter/X Ads
  "li_fat_id",  // LinkedIn Ads
  "rdt_cid",    // Reddit Ads
  "ttclid",     // TikTok Ads
] as const;

/**
 * Query parameters that are ALWAYS stripped from forwarded and stored URLs,
 * regardless of consumer configuration, because they carry high-sensitivity
 * secrets that must never reach Formo:
 * - privy_oauth_code:     Privy OAuth authorization code
 * - privy_oauth_state:    Privy OAuth CSRF state token
 * - privy_oauth_provider: Privy OAuth provider identifier
 *
 * Consumers can extend the denylist via `tracking.excludeQueryParams` but
 * cannot remove these built-ins. Matched case-insensitively.
 */
const DEFAULT_EXCLUDED_QUERY_PARAMS = [
  "privy_oauth_code",
  "privy_oauth_state",
  "privy_oauth_provider",
] as const;

/**
 * Default query parameter names checked (in order) for a referral code on the
 * landing-page URL. The first parameter present supplies the `ref` traffic
 * source. Consumers can override this list via `referral.queryParams`.
 *
 * Keep in sync with the ReferralOptions.queryParams @default in
 * src/types/base.ts.
 */
const DEFAULT_REFERRAL_PARAMS = [
  'ref',
  'referral',
  'refcode',
  'af',
  'referrer',
] as const;

/**
 * Fields that should be excluded from page event properties parsing
 * These are either:
 * - Already captured in event context (UTM params, referral params, click IDs)
 * - Semantic event properties that should not be overridden by URL params
 */
const PAGE_PROPERTIES_EXCLUDED_FIELDS = new Set<string>([
  // Context fields (already captured in event context)
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  ...DEFAULT_REFERRAL_PARAMS,
  ...CLICK_ID_PARAMS,
  // Semantic event properties (should not be overridden by URL params)
  'category',
  'name',
  'url',
  'path',
  'hash',
  'query',
]);

export {
  CHANNEL,
  VERSION,
  CLICK_ID_PARAMS,
  DEFAULT_EXCLUDED_QUERY_PARAMS,
  DEFAULT_REFERRAL_PARAMS,
  PAGE_PROPERTIES_EXCLUDED_FIELDS,
};
