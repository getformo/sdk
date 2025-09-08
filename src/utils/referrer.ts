/**
 * Utility functions for handling referrer filtering
 */

/**
 * Extracts the domain from a URL
 * @param url The URL to extract domain from
 * @returns The domain (hostname) or empty string if invalid
 */
function extractDomain(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Checks if two domains are considered the same (accounting for subdomains)
 * @param domain1 First domain
 * @param domain2 Second domain
 * @returns True if domains match (including subdomains)
 */
function domainsMatch(domain1: string, domain2: string): boolean {
  if (!domain1 || !domain2) return false;
  
  // Exact match
  if (domain1 === domain2) return true;
  
  // Split domains into parts and reverse to start from TLD
  const parts1 = domain1.split('.').reverse();
  const parts2 = domain2.split('.').reverse();
  
  // Need at least 2 parts for a valid domain (domain.tld)
  if (parts1.length < 2 || parts2.length < 2) return false;
  
  // For domains to match, they need to share the same root domain (at least domain.tld)
  // Check if they share at least the last 2 parts (TLD and domain)
  const minRootParts = 2;
  
  if (parts1.length < minRootParts || parts2.length < minRootParts) return false;
  
  // Check if the root domain parts match (TLD and main domain name)
  for (let i = 0; i < minRootParts; i++) {
    if (parts1[i] !== parts2[i]) return false;
  }
  
  return true;
}

/**
 * Checks if a referrer should be filtered as internal
 * @param referrer The referrer URL
 * @param currentUrl The current page URL  
 * @returns True if referrer should be filtered (is internal)
 */
export function isInternalReferrer(
  referrer: string,
  currentUrl: string
): boolean {
  if (!referrer) return false;
  
  const referrerDomain = extractDomain(referrer);
  if (!referrerDomain) return false;
  
  const currentDomain = extractDomain(currentUrl);
  if (!currentDomain) return false;
  
  // Check if referrer matches current domain (automatic internal filtering)
  return domainsMatch(referrerDomain, currentDomain);
}

/**
 * Filters referrer if it's internal, returning empty string if filtered
 * @param referrer The referrer URL
 * @param currentUrl The current page URL
 * @returns The referrer if external, empty string if internal
 */
export function filterInternalReferrer(
  referrer: string,
  currentUrl: string
): string {
  if (isInternalReferrer(referrer, currentUrl)) {
    return "";
  }
  return referrer;
}
