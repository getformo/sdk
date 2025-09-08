/**
 * Consent management utilities for handling tracking consent flags in cookies.
 * These functions bypass the consent-aware storage system to ensure consent 
 * preferences are always stored persistently for compliance purposes.
 * 
 * All consent cookies are project-specific to avoid conflicts between different
 * Formo projects on the same domain.
 */

/**
 * Generate a simple hash of a string for creating short, consistent identifiers
 * @param str - The string to hash
 * @returns Short hash string
 */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(36).slice(0, 8);
}

/**
 * Generate a project-specific cookie key to avoid conflicts between different Formo projects
 * @param projectId - The project identifier (writeKey)
 * @param key - The base cookie key
 * @returns Project-specific cookie key
 */
function getProjectSpecificKey(projectId: string, key: string): string {
  // Use a hash of the projectId to keep cookie names reasonable length
  const projectHash = simpleHash(projectId);
  return `formo_${projectHash}_${key}`;
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
    document.cookie = `${projectSpecificKey}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Strict${isSecure ? '; Secure' : ''}`;
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
  if (typeof window !== 'undefined') {
    const hostname = window.location.hostname;
    const parts = hostname.split('.');
    
    // Only try parent domain deletion for proper domains with multiple parts
    // Skip localhost and single-level domains
    if (parts.length >= 2 && hostname !== 'localhost') {
      const domain = parts.slice(-2).join('.');
      document.cookie = `${cookieName}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; domain=.${domain};`;
    }
  }
}
