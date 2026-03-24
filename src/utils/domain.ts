/**
 * Domain utilities for cross-subdomain cookie sharing.
 *
 * Uses a cookie-probe approach: tries setting a test cookie on progressively
 * shorter domain candidates until the browser accepts one. This is
 * self-maintaining — no hardcoded public suffix lists to keep up to date.
 * The browser itself is the authority on which domains accept cookies.
 */

const TEST_COOKIE_NAME = '__formo_domain_probe';

/** Cached result so we only probe once per page load. */
let cachedApexDomain: string | null | undefined;

/**
 * Try to set a test cookie on the given domain. Returns true if the browser
 * accepted it (i.e. the cookie is readable back).
 */
function canSetCookieOnDomain(domain: string): boolean {
  const cookieVal = 'probe';
  document.cookie = `${TEST_COOKIE_NAME}=${cookieVal}; domain=.${domain}; path=/; max-age=10`;
  const accepted = document.cookie.indexOf(`${TEST_COOKIE_NAME}=${cookieVal}`) !== -1;
  // Clean up regardless of result
  document.cookie = `${TEST_COOKIE_NAME}=; domain=.${domain}; path=/; max-age=0`;
  return accepted;
}

/**
 * Extract the apex (registrable) domain for cookie sharing across subdomains.
 *
 * Walks up the hostname labels from shortest candidate to longest, probing
 * with a test cookie. The shortest domain the browser accepts is the apex.
 *
 * Returns null for localhost, IP addresses, single-label hosts, SSR, or
 * when no candidate domain accepts cookies (e.g. public suffix hosts like
 * vercel.app or github.io).
 *
 * Results are cached for the lifetime of the page.
 */
export function getApexDomain(): string | null {
  if (typeof window === 'undefined') return null;
  if (cachedApexDomain !== undefined) return cachedApexDomain;

  const hostname = window.location.hostname;
  if (hostname === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    cachedApexDomain = null;
    return null;
  }

  const parts = hostname.split('.');
  if (parts.length < 2) {
    cachedApexDomain = null;
    return null;
  }

  // Walk from the shortest candidate (last 2 labels) to the full hostname.
  // The shortest domain the browser accepts is the apex domain.
  for (let i = 2; i <= parts.length; i++) {
    const candidate = parts.slice(-i).join('.');
    if (canSetCookieOnDomain(candidate)) {
      cachedApexDomain = candidate;
      return candidate;
    }
  }

  cachedApexDomain = null;
  return null;
}

/**
 * Reset the cached apex domain. Exposed for testing only.
 * @internal
 */
export function _resetApexDomainCache(): void {
  cachedApexDomain = undefined;
}
