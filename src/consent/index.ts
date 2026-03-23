/**
 * Consent management utilities for handling tracking consent flags in cookies.
 * These functions bypass the consent-aware storage system to ensure consent 
 * preferences are always stored persistently for compliance purposes.
 * 
 * All consent cookies are project-specific to avoid conflicts between different
 * Formo projects on the same domain.
 */

import { secureHash } from '../utils/hash';

/**
 * Known public suffixes where browsers reject cookies.
 * Organized by number of parts (checked longest-first) so that
 * 3-part suffixes like s3.amazonaws.com are matched before the
 * 2-part amazonaws.com would be.
 *
 * Not exhaustive — when no match is found the hostname is assumed
 * to have a single-part TLD, which is correct for .com/.io/.app/etc.
 * When in doubt, getApexDomain() returns null (no domain attribute),
 * which is safe.
 */
const PUBLIC_SUFFIXES_3 = new Set([
  // AWS — subdomains of amazonaws.com are themselves public suffixes
  's3.amazonaws.com', 'compute.amazonaws.com',
  'elb.amazonaws.com', 'execute-api.amazonaws.com',
  's3.amazonaws.com.cn', 'compute.amazonaws.com.cn',
]);

const PUBLIC_SUFFIXES_2 = new Set([
  // Country-code second-level domains
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'net.uk',
  'com.au', 'net.au', 'org.au', 'edu.au',
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp',
  'com.br', 'org.br', 'net.br',
  'co.nz', 'net.nz', 'org.nz',
  'co.za', 'org.za', 'web.za',
  'com.cn', 'net.cn', 'org.cn',
  'co.in', 'net.in', 'org.in', 'gen.in',
  'co.kr', 'or.kr', 'ne.kr',
  'com.mx', 'org.mx', 'net.mx',
  'com.tw', 'org.tw', 'net.tw',
  'com.hk', 'org.hk', 'net.hk',
  'com.sg', 'org.sg', 'net.sg', 'edu.sg',
  'co.il', 'org.il', 'net.il',
  'com.ar', 'org.ar', 'net.ar',
  'com.tr', 'org.tr', 'net.tr',
  'co.th', 'or.th', 'in.th',
  'com.my', 'org.my', 'net.my',
  'com.pk', 'org.pk', 'net.pk',
  'com.ng', 'org.ng', 'net.ng',
  'com.ph', 'org.ph', 'net.ph',
  'com.eg', 'org.eg', 'net.eg',
  'co.id', 'or.id', 'web.id',
  // Platform public suffixes (browsers reject cookies on these)
  'github.io', 'gitlab.io', 'herokuapp.com', 'vercel.app',
  'netlify.app', 'pages.dev', 'workers.dev', 'fly.dev',
  'azurewebsites.net', 'cloudfront.net',
  'web.app', 'firebaseapp.com',
]);

/**
 * Determine the number of parts in the public suffix for a given hostname.
 * Returns 1 for standard TLDs (.com, .io), 2 for known two-part suffixes
 * (.co.uk, github.io), 3 for known three-part suffixes (s3.amazonaws.com).
 * Returns -1 if the hostname itself IS a public suffix (no registrable domain).
 */
function getPublicSuffixLength(parts: string[]): number {
  // Check 3-part suffixes first (longest match wins)
  if (parts.length >= 3) {
    const last3 = parts.slice(-3).join('.');
    if (PUBLIC_SUFFIXES_3.has(last3)) {
      // Hostname is or sits under a 3-part suffix — need 4+ parts for a registrable domain
      return parts.length < 4 ? -1 : 3;
    }
  }

  if (parts.length >= 2) {
    const last2 = parts.slice(-2).join('.');
    if (PUBLIC_SUFFIXES_2.has(last2)) {
      return parts.length < 3 ? -1 : 2;
    }
  }

  // Default: single-part TLD (.com, .io, .app, etc.)
  return parts.length < 2 ? -1 : 1;
}

/**
 * Extract the apex domain for cookie sharing across subdomains.
 * Returns null for localhost, IP addresses, single-level domains,
 * or when the apex domain cannot be reliably determined.
 */
function getApexDomain(): string | null {
  if (typeof window === 'undefined') return null;
  const hostname = window.location.hostname;
  if (hostname === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return null;
  const parts = hostname.split('.');
  if (parts.length < 2) return null;

  const suffixLen = getPublicSuffixLength(parts);
  if (suffixLen === -1) return null; // hostname is itself a public suffix
  return parts.slice(-(suffixLen + 1)).join('.');
}

/**
 * Generate a project-specific cookie key to avoid conflicts between different Formo projects
 * Uses hashed writeKey for privacy and security
 * @param projectId - The project identifier (writeKey)
 * @param key - The base cookie key
 * @returns Project-specific cookie key
 */
function getProjectSpecificKey(projectId: string, key: string): string {
  return `formo_${secureHash(projectId)}_${key}`;
}

/**
 * Set a consent flag directly in cookies, bypassing the consent-aware storage system.
 * Uses cookies for consent storage to ensure:
 * - Cross-domain/subdomain compatibility
 * - Server-side accessibility for compliance auditing
 * - Regulatory compliance (GDPR/CCPA requirements)
 * - Explicit expiration handling
 * - Project isolation (no conflicts between different Formo projects)
 * @param projectId - The project identifier (writeKey)
 * @param key - The cookie key
 * @param value - The cookie value
 */
export function setConsentFlag(projectId: string, key: string, value: string): void {
  if (typeof document !== 'undefined') {
    const projectSpecificKey = getProjectSpecificKey(projectId, key);
    const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toUTCString(); // 1 year (GDPR compliant)
    const isSecure = window?.location?.protocol === 'https:';
    // Enhanced privacy settings: Secure (HTTPS), SameSite=Strict for consent cookies
    const domain = getApexDomain();
    const domainAttr = domain ? `; domain=.${domain}` : '';
    document.cookie = `${projectSpecificKey}=${encodeURIComponent(value)}; expires=${expires}; path=/${domainAttr}; SameSite=Strict${isSecure ? '; Secure' : ''}`;
  }
}

/**
 * Get a consent flag directly from cookies, bypassing the consent-aware storage system
 * @param projectId - The project identifier (writeKey)
 * @param key - The cookie key
 * @returns The cookie value or null if not found
 */
export function getConsentFlag(projectId: string, key: string): string | null {
  if (typeof document === 'undefined') return null;
  
  const projectSpecificKey = getProjectSpecificKey(projectId, key);
  const cookies = document.cookie.split(';');
  for (const cookie of cookies) {
    const trimmed = cookie.trim();
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const cookieKey = trimmed.substring(0, eqIdx);
    const cookieValue = trimmed.substring(eqIdx + 1);
    if (cookieKey === projectSpecificKey) {
      return decodeURIComponent(cookieValue || '');
    }
  }
  return null;
}

/**
 * Remove a consent flag directly from cookies, bypassing the consent-aware storage system
 * @param projectId - The project identifier (writeKey)
 * @param key - The cookie key
 */
export function removeConsentFlag(projectId: string, key: string): void {
  const projectSpecificKey = getProjectSpecificKey(projectId, key);
  deleteCookieDirectly(projectSpecificKey);
}


/**
 * Delete a cookie directly, handling various domain scenarios
 * @param cookieName - The name of the cookie to delete
 */
function deleteCookieDirectly(cookieName: string): void {
  if (typeof document === 'undefined') return;
  
  // Clear from current domain/path
  document.cookie = `${cookieName}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;`;
  
  // Try to clear from parent domain if it's a proper multi-level domain
  const domain = getApexDomain();
  if (domain) {
    document.cookie = `${cookieName}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; domain=.${domain};`;
  }
}
