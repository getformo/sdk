/**
 * Optional React binding for Privy identity.
 *
 * This module imports React and therefore lives outside the React-free `core`
 * entry point. Import it from the package root (`@formo/analytics`).
 */

import { useEffect } from "react";
import { useFormo } from "../FormoAnalyticsProvider";
import { logger } from "../logger";
import {
  identifyPrivyUser,
  isPrivyWalletAccount,
  IdentifyPrivyUserOptions,
} from "./utils";
import { PrivyUser } from "./types";

export interface UseIdentifyPrivyUserOptions extends IdentifyPrivyUserOptions {
  /**
   * Gate the effect. Pass Privy's `authenticated` (or `ready && authenticated`)
   * so nothing is identified while auth is still resolving or the user is
   * logged out. Defaults to `true`.
   */
  enabled?: boolean;
}

/**
 * Keep Formo's identity in sync with the Privy `usePrivy()` user object.
 *
 * Drop this hook into any component under `FormoAnalyticsProvider` and pass it
 * the Privy `user`. Whenever the user's Privy DID or the set of linked wallet
 * addresses changes — covering login, `linkWallet` success, and `unlinkWallet`
 * — it re-runs {@link identifyPrivyUser}, so every wallet stays tagged with the
 * user's DID for server-side clustering.
 *
 * The effect is keyed on a stable signature of the DID + sorted linked-wallet
 * addresses + active address, not on the `user` object reference (which Privy
 * re-creates on every render), so it fires only on meaningful changes.
 * `options.properties` is intentionally NOT part of the key: identify events
 * are deduped per `(wallet, user)` per session, so property-only changes would
 * not re-emit anyway — treat properties as identity metadata set at first
 * identify (see {@link IdentifyPrivyUserOptions.properties}).
 *
 * Scope: this emits positive identify (wallet↔user link) events only. Unlinking
 * a wallet re-runs the effect for the smaller set, but there is no SDK-level
 * "unlink" event, so links are additive from the backend's perspective.
 *
 * @example
 * ```tsx
 * import { usePrivy, useWallets } from '@privy-io/react-auth';
 * import { useIdentifyPrivyUser } from '@formo/analytics';
 *
 * function AnalyticsIdentity() {
 *   const { user, authenticated, ready } = usePrivy();
 *   const { wallets } = useWallets();
 *   useIdentifyPrivyUser(user, {
 *     enabled: ready && authenticated,
 *     activeAddress: wallets[0]?.address,
 *   });
 *   return null;
 * }
 * ```
 */
export function useIdentifyPrivyUser(
  user: PrivyUser | null | undefined,
  options: UseIdentifyPrivyUserOptions = {}
): void {
  const analytics = useFormo();
  const { enabled = true, activeAddress, properties } = options;

  // A stable, order-independent signature of the linked wallet set. Used so the
  // effect re-runs when a wallet is linked or unlinked, but not on every render.
  const walletSignature = user
    ? (user.linkedAccounts || [])
        .filter(isPrivyWalletAccount)
        .map((a) => (a.address as string).toLowerCase())
        .sort()
        .join(",")
    : "";

  // Empty signature => nothing to do (logged out or disabled).
  const signature =
    user && enabled
      ? [user.id, activeAddress?.toLowerCase() ?? "", walletSignature].join("|")
      : "";

  useEffect(() => {
    if (!signature || !user) return;
    identifyPrivyUser(analytics, user, { activeAddress, properties }).catch(
      (err) => logger.error("useIdentifyPrivyUser: identify failed", err)
    );
    // Keyed on the derived `signature` string rather than the `user`/`options`
    // object references, which change identity on every render. `user`,
    // `activeAddress`, and `properties` are read fresh inside the effect and
    // are consistent with the signature that triggered it.
  }, [analytics, signature]);
}
