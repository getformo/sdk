const CHANNEL = "web";
const VERSION = "0";

/**
 * Fields that should be excluded from page event properties parsing
 * These are either:
 * - Already captured in event context (UTM params, referral params)
 * - Semantic event properties that should not be overridden by URL params
 */
const PAGE_PROPERTIES_EXCLUDED_FIELDS = new Set([
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
  // Semantic event properties (should not be overridden by URL params)
  'category',
  'name',
  'url',
  'path',
  'hash',
  'query',
]);

export { CHANNEL, VERSION, PAGE_PROPERTIES_EXCLUDED_FIELDS };
