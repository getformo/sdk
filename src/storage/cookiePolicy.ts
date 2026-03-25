/**
 * Cookie domain policy — centralizes the decision of whether identity
 * cookies should be host-scoped or apex-scoped.
 *
 * - true (default): domain set to .apexDomain → shared across subdomains
 * - false: no domain attribute → cookie scoped to current host
 */
import { getApexDomain } from "../utils/domain";

/**
 * Returns the domain attribute string for identity cookies.
 * - false → "" (no domain attribute, host-only)
 * - true  → ".example.com" when a valid apex domain is detected,
 *            or "" on localhost / IP / single-label hosts
 *
 * @param crossSubdomain Whether cookies should be shared across subdomains.
 */
export function getIdentityCookieDomain(crossSubdomain = true): string {
  if (!crossSubdomain) return "";
  const domain = getApexDomain();
  return domain ? `.${domain}` : "";
}
