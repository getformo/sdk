/**
 * Domain utilities for cross-subdomain cookie sharing.
 *
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
const PUBLIC_SUFFIXES_4 = new Set([
  // AWS China — 4-part public suffixes
  's3.amazonaws.com.cn', 'compute.amazonaws.com.cn',
]);

const PUBLIC_SUFFIXES_3 = new Set([
  // AWS — subdomains of amazonaws.com are themselves public suffixes
  's3.amazonaws.com', 'compute.amazonaws.com',
  'elb.amazonaws.com', 'execute-api.amazonaws.com',
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
 * (.co.uk, github.io), 3 for known three-part suffixes (s3.amazonaws.com),
 * 4 for known four-part suffixes (s3.amazonaws.com.cn).
 * Returns -1 if the hostname itself IS a public suffix (no registrable domain).
 */
function getPublicSuffixLength(parts: string[]): number {
  // Check longest suffixes first (longest match wins)
  if (parts.length >= 4) {
    const last4 = parts.slice(-4).join('.');
    if (PUBLIC_SUFFIXES_4.has(last4)) {
      return parts.length < 5 ? -1 : 4;
    }
  }

  if (parts.length >= 3) {
    const last3 = parts.slice(-3).join('.');
    if (PUBLIC_SUFFIXES_3.has(last3)) {
      return parts.length < 4 ? -1 : 3;
    }
  }

  if (parts.length >= 2) {
    const last2 = parts.slice(-2).join('.');
    if (PUBLIC_SUFFIXES_2.has(last2)) {
      return parts.length < 3 ? -1 : 2;
    }
  }

  // If the second-to-last label looks like a common SLD prefix (com, co, org,
  // etc.) but we didn't match it above, it's likely an unrecognized multi-part
  // public suffix (e.g. .com.ua, .co.ke). Return null to fall back to safe
  // host-only cookies rather than risk setting domain=.com.ua.
  if (parts.length >= 3) {
    const COMMON_SLD_PREFIXES = new Set([
      'com', 'co', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne', 'go',
      'gen', 'web', 'in', 'me',
    ]);
    const secondToLast = parts[parts.length - 2];
    if (COMMON_SLD_PREFIXES.has(secondToLast)) {
      return -1;
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
export function getApexDomain(): string | null {
  if (typeof window === 'undefined') return null;
  const hostname = window.location.hostname;
  if (hostname === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return null;
  const parts = hostname.split('.');
  if (parts.length < 2) return null;

  const suffixLen = getPublicSuffixLength(parts);
  if (suffixLen === -1) return null; // hostname is itself a public suffix
  return parts.slice(-(suffixLen + 1)).join('.');
}
