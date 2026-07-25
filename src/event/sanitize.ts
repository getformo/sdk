import { ITrafficSource } from "../types";
import { CLICK_ID_PARAMS } from "./constants";

/**
 * Traffic-source value sanitization.
 *
 * Vulnerability scanners (e.g. Acunetix) crawl customer sites injecting XSS
 * probes such as `javascript:domxssExecutionSink(1,"'\"><xsstag>()locxss")`
 * or `<script>alert(1)</script>` into every query parameter. Without
 * validation those payloads are captured verbatim as utm_* / click-id / ref
 * values, persisted as sticky session traffic sources, and pollute the
 * customer's attribution reporting. Each field class gets the tightest rule
 * its legitimate values allow (verified against production data):
 *
 * - Click IDs are opaque platform-generated tokens (base64url-ish); every
 *   legitimate production value matches the strict token pattern.
 * - Referral codes are short tokens; >99.5% of production values match the
 *   strict pattern and none of the remainder are legitimate (scanner
 *   payloads, mangled encodings, URLs glued to codes).
 * - UTM values are free-form (spaces, unicode, `+` are legitimate), so they
 *   only reject markup/quote characters, dangerous URL schemes, control and
 *   zero-width characters, and absurd lengths.
 *
 * Invalid values are dropped to "" — the same representation as "parameter
 * absent" — rather than repaired, so a poisoned value can never be persisted
 * or reported.
 */

const CLICK_ID_PATTERN = /^[A-Za-z0-9._-]{1,255}$/;

const REF_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

const UTM_MAX_LENGTH = 255;

// Markup/quote/backslash characters plus C0/C1 control characters and
// zero-width / bidi / BOM / replacement characters (mangled-encoding
// markers). Explicit ranges instead of \p{C} to avoid the `u`-flag
// property-escape requirement.
const UTM_FORBIDDEN_CHARS =
  /[<>"'`\\\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060\ufeff\ufffd]/;

// Values smuggling an executable/URL scheme, e.g. `javascript:alert(1)`.
const FORBIDDEN_SCHEME_PREFIX = /^\s*(javascript|data|vbscript):/i;

const sanitizeClickId = (value: string): string =>
  CLICK_ID_PATTERN.test(value) ? value : "";

const sanitizeRef = (value: string): string =>
  REF_PATTERN.test(value) ? value : "";

const sanitizeUtm = (value: string): string =>
  value.length <= UTM_MAX_LENGTH &&
  !UTM_FORBIDDEN_CHARS.test(value) &&
  !FORBIDDEN_SCHEME_PREFIX.test(value)
    ? value
    : "";

const CLICK_ID_KEYS: ReadonlySet<string> = new Set(CLICK_ID_PARAMS);

/**
 * Sanitize every traffic-source field of a (possibly sparse) traffic-source
 * object. `referrer` is left untouched: it is a browser-set URL already
 * handled by redactUrl, not an attacker-controlled query parameter. Unknown
 * keys fall through to the UTM rule, the most permissive one.
 */
const sanitizeTrafficSources = <T extends Partial<ITrafficSource>>(
  trafficSources: T
): T => {
  const result: Record<string, unknown> = { ...trafficSources };
  for (const key of Object.keys(result)) {
    const value = result[key];
    if (typeof value !== "string" || value === "" || key === "referrer") {
      continue;
    }
    if (CLICK_ID_KEYS.has(key)) {
      result[key] = sanitizeClickId(value);
    } else if (key === "ref") {
      result[key] = sanitizeRef(value);
    } else {
      result[key] = sanitizeUtm(value);
    }
  }
  return result as T;
};

export { sanitizeClickId, sanitizeRef, sanitizeUtm, sanitizeTrafficSources };
