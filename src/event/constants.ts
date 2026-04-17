const CHANNEL = "web";
const VERSION = "0";

/**
 * Paid-attribution click IDs captured from the landing-page URL and persisted
 * across the session alongside UTM parameters. Keep in sync with the
 * ClickIdParameters type in src/types/events.ts.
 */
const CLICK_ID_PARAMS = [
  "gclid",      // Google Ads
  "gad_source", // Google Ads (newer)
  "gbraid",     // Google Ads iOS App
  "wbraid",     // Google Ads iOS Web
  "dclid",      // Google Display & Video 360
  "fbclid",     // Meta (Facebook/Instagram)
  "msclkid",    // Microsoft Ads (Bing)
  "yclid",      // Yandex.Direct
  "ttclid",     // TikTok Ads
  "twclid",     // Twitter/X Ads
  "li_fat_id",  // LinkedIn Ads
  "rdt_cid",    // Reddit Ads
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
  'ref',
  'referral',
  'refcode',
  'referrer',
  ...CLICK_ID_PARAMS,
  // Semantic event properties (should not be overridden by URL params)
  'category',
  'name',
  'url',
  'path',
  'hash',
  'query',
]);

export { CHANNEL, VERSION, CLICK_ID_PARAMS, PAGE_PROPERTIES_EXCLUDED_FIELDS };
