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

/**
 * Security attributes for identity/session cookies (user-id,
 * active-wallet, wallet-detected/identified).
 *
 * - `sameSite: "lax"` — first-party analytics identity. Lax keeps the
 *   cookie on top-level navigations (so attribution survives a click-in
 *   from another site) while blocking it on cross-site subrequests.
 *   Strict would silently drop identity on inbound navigation.
 * - `secure` — only on HTTPS. Setting Secure over plain HTTP (local dev)
 *   makes the browser reject the cookie outright, so it must be
 *   conditional.
 */
export function getIdentityCookieSecurity(): {
  sameSite: "lax";
  secure: boolean;
} {
  const isHttps =
    typeof window !== "undefined" &&
    window.location?.protocol === "https:";
  return { sameSite: "lax", secure: isHttps };
}
