/**
 * Cookie domain policy — centralizes the decision of whether identity
 * cookies should be host-scoped or apex-scoped.
 *
 * - 'host' (default): no domain attribute → cookie scoped to current host
 * - 'apex': domain set to .apexDomain → shared across subdomains
 */
import { getApexDomain } from "../utils/domain";

let _scope: 'host' | 'apex' = 'host';

export function setCookieScope(scope: 'host' | 'apex'): void {
  _scope = scope;
}

export function getCookieScope(): 'host' | 'apex' {
  return _scope;
}

/**
 * Returns the domain attribute string for identity cookies based on
 * the configured scope.
 * - 'host' → "" (no domain attribute, host-only)
 * - 'apex' → ".example.com" when a valid apex domain is detected,
 *            or "" on localhost / IP / single-label hosts
 *
 * @param scope Optional explicit scope override. When provided, this
 *   takes precedence over the module-level default, allowing each SDK
 *   instance to use its own cookie scope without cross-instance interference.
 */
export function getIdentityCookieDomain(scope?: 'host' | 'apex'): string {
  const effectiveScope = scope ?? _scope;
  if (effectiveScope !== 'apex') return "";
  const domain = getApexDomain();
  return domain ? `.${domain}` : "";
}
