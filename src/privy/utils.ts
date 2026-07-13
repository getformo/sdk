/**
 * Utility functions for extracting profile properties from Privy user objects.
 */

import {
  PrivyLinkedAccount,
  PrivyProfileProperties,
  PrivyUser,
  PrivyWalletInfo,
} from "./types";
import { IFormoAnalytics } from "../types/base";
import { IFormoEventProperties } from "../types/events";
import { logger } from "../logger";

/**
 * Whether a Privy linked account is a usable wallet — an EVM/Solana wallet or
 * smart wallet with an address. Shared by {@link parsePrivyProperties} and the
 * React binding so the "which accounts are wallets" rule can't drift between
 * them.
 */
export function isPrivyWalletAccount(account: PrivyLinkedAccount): boolean {
  return (
    (account.type === "wallet" || account.type === "smart_wallet") &&
    !!account.address
  );
}

/**
 * Extract profile properties and wallet addresses from a Privy user object.
 *
 * Parses the Privy user's linked accounts into a flat properties object
 * (email, social accounts, etc.) and extracts all linked wallet addresses.
 *
 * For most apps prefer the {@link identifyPrivyUser} one-liner, which builds on
 * this function and also forwards per-wallet metadata and handles event
 * attribution. Use `parsePrivyProperties` directly only for advanced/custom
 * flows.
 *
 * @param user - The Privy user object from `usePrivy()`
 * @returns An object with `properties` and `wallets`
 *
 * @example
 * ```ts
 * import { parsePrivyProperties } from '@formo/analytics';
 *
 * const { user } = usePrivy();
 * if (user) {
 *   const { properties, wallets } = parsePrivyProperties(user);
 *
 *   for (const wallet of wallets) {
 *     formo.identify({ address: wallet.address, userId: user.id }, properties);
 *   }
 * }
 * ```
 */
export function parsePrivyProperties(user: PrivyUser): {
  properties: PrivyProfileProperties;
  wallets: PrivyWalletInfo[];
} {
  const accounts = user.linkedAccounts || [];

  // Extract profile properties
  const properties: PrivyProfileProperties = {
    privyDid: user.id,
    privyCreatedAt: user.createdAt?.getTime(),
  };

  // Email
  if (user.email?.address) {
    properties.email = user.email.address;
  }

  // Social accounts - extract usernames/identifiers
  if (user.apple?.email) {
    properties.apple = user.apple.email;
  }

  if (user.discord?.username) {
    properties.discord = user.discord.username;
  }

  if (user.farcaster?.username) {
    properties.farcaster = user.farcaster.username;
  }

  if (user.github?.username) {
    properties.github = user.github.username;
  }

  if (user.google?.email) {
    properties.google = user.google.email;
  }

  if (user.instagram?.username) {
    properties.instagram = user.instagram.username;
  }

  if (user.line?.email) {
    properties.line = user.line.email;
  }

  if (user.linkedin?.email) {
    properties.linkedin = user.linkedin.email;
  }

  if (user.spotify?.email) {
    properties.spotify = user.spotify.email;
  }

  if (user.telegram?.username) {
    properties.telegram = user.telegram.username;
  }

  if (user.tiktok?.username) {
    properties.tiktok = user.tiktok.username;
  }

  if (user.twitter?.username) {
    properties.twitter = user.twitter.username;
  }

  // Fallback to linkedAccounts if convenience accessors are not populated
  if (!properties.email) {
    const emailAccount = accounts.find((account) => account.type === "email");
    if (emailAccount?.address) {
      properties.email = emailAccount.address;
    }
  }

  if (!properties.apple) {
    const appleAccount = accounts.find((a) => a.type === "apple_oauth");
    if (appleAccount?.email) {
      properties.apple = appleAccount.email;
    }
  }

  if (!properties.discord) {
    const discordAccount = accounts.find((a) => a.type === "discord_oauth");
    if (discordAccount?.username) {
      properties.discord = discordAccount.username;
    }
  }

  if (!properties.farcaster) {
    const farcasterAccount = accounts.find((a) => a.type === "farcaster");
    if (farcasterAccount?.username) {
      properties.farcaster = farcasterAccount.username;
    } else if (farcasterAccount?.displayName) {
      properties.farcaster = farcasterAccount.displayName;
    }
  }

  if (!properties.github) {
    const githubAccount = accounts.find((a) => a.type === "github_oauth");
    if (githubAccount?.username) {
      properties.github = githubAccount.username;
    }
  }

  if (!properties.google) {
    const googleAccount = accounts.find((a) => a.type === "google_oauth");
    if (googleAccount?.email) {
      properties.google = googleAccount.email;
    }
  }

  if (!properties.instagram) {
    const instagramAccount = accounts.find((a) => a.type === "instagram_oauth");
    if (instagramAccount?.username) {
      properties.instagram = instagramAccount.username;
    }
  }

  if (!properties.line) {
    const lineAccount = accounts.find((a) => a.type === "line_oauth");
    if (lineAccount?.email) {
      properties.line = lineAccount.email;
    }
  }

  if (!properties.linkedin) {
    const linkedinAccount = accounts.find((a) => a.type === "linkedin_oauth");
    if (linkedinAccount?.email) {
      properties.linkedin = linkedinAccount.email;
    }
  }

  if (!properties.spotify) {
    const spotifyAccount = accounts.find((a) => a.type === "spotify_oauth");
    if (spotifyAccount?.email) {
      properties.spotify = spotifyAccount.email;
    }
  }

  if (!properties.telegram) {
    const telegramAccount = accounts.find((a) => a.type === "telegram");
    if (telegramAccount?.username) {
      properties.telegram = telegramAccount.username;
    } else if (telegramAccount?.telegramUserId) {
      properties.telegram = telegramAccount.telegramUserId;
    }
  }

  if (!properties.tiktok) {
    const tiktokAccount = accounts.find((a) => a.type === "tiktok_oauth");
    if (tiktokAccount?.username) {
      properties.tiktok = tiktokAccount.username;
    }
  }

  if (!properties.twitter) {
    const twitterAccount = accounts.find((a) => a.type === "twitter_oauth");
    if (twitterAccount?.username) {
      properties.twitter = twitterAccount.username;
    }
  }

  // Use OAuth emails as fallback for email if still blank
  // Priority: email -> google -> apple -> linkedin
  if (!properties.email) {
    if (properties.google) {
      properties.email = properties.google;
    } else if (properties.apple) {
      properties.email = properties.apple;
    } else if (properties.linkedin) {
      properties.email = properties.linkedin;
    }
  }

  // Extract wallet addresses
  const wallets: PrivyWalletInfo[] = accounts
    .filter(isPrivyWalletAccount)
    .map((a) => ({
      address: a.address!,
      walletClient: (a.walletClientType || a.walletClient) ?? undefined,
      chainType: a.chainType ?? undefined,
      isEmbedded:
        a.walletClientType === "privy" || a.walletClient === "privy",
    }));

  return { properties, wallets };
}

/**
 * Options for {@link identifyPrivyUser}.
 */
export interface IdentifyPrivyUserOptions {
  /**
   * Address of the wallet the user is actively transacting with — typically
   * the connected wallet from Privy's `useWallets()` (`wallets[0]?.address`)
   * or your wagmi account.
   *
   * A Privy user's `linkedAccounts` lists every wallet they have ever linked,
   * not which one is currently connected, so the SDK cannot tell them apart on
   * its own. When resolved, that wallet is identified last and becomes the
   * address later events are attributed to, while the other linked wallets are
   * recorded for identity clustering without taking over attribution.
   *
   * Resolution order:
   * 1. this `activeAddress`, if it matches a linked wallet;
   * 2. else the SDK's existing `currentAddress` (e.g. from a prior wagmi
   *    connect), if it matches a linked wallet;
   * 3. else a best-effort guess: embedded (Privy) wallets first, attributing to
   *    the last external wallet.
   *
   * So if you already track wallet connects, you can usually omit this.
   */
  activeAddress?: string;

  /**
   * Extra properties merged into every identify call, on top of the profile
   * properties parsed from the Privy user (email, socials, DID, …) and the
   * per-wallet metadata (`wallet_client`, `chain_type`, `is_embedded`).
   *
   * Note: because identify events are deduped per `(wallet, user)` within a
   * session, these properties are effectively captured on the *first* identify
   * for each wallet and are not refreshed by later calls in the same session.
   * Treat them as identity metadata set at identify time, not a live profile.
   */
  properties?: IFormoEventProperties;
}

/**
 * Identify every wallet linked to a Privy user under that user's Privy DID.
 *
 * This is the one-liner replacement for hand-rolling a loop over
 * {@link parsePrivyProperties}. For each linked wallet it calls
 * `analytics.identify({ address, userId: user.id }, …)` with the shared
 * profile properties plus that wallet's `wallet_client`, `chain_type`, and
 * `is_embedded` metadata. Because every wallet is tagged with the same Privy
 * `userId`, Formo can cluster them server-side into a single user.
 *
 * Attribution: only the active/connected wallet (see
 * {@link IdentifyPrivyUserOptions.activeAddress}) is promoted to the SDK's
 * active identity; the rest are identified with `setActive: false` so they do
 * not hijack which wallet subsequent events are attributed to.
 *
 * All linked wallet addresses used here come from `user.linkedAccounts`, which
 * is fully available on the frontend from Privy's `usePrivy()` hook.
 *
 * Note: `identify()` is keyed on a wallet address, so a Privy user with no
 * linked wallet is a no-op (nothing is emitted). Attaching a user identity that
 * has no wallet is out of scope for this address-keyed helper.
 *
 * @param analytics - The Formo analytics instance (e.g. from `useFormo()`)
 * @param user - The Privy user object from `usePrivy()`
 * @param options - See {@link IdentifyPrivyUserOptions}
 *
 * @example
 * ```ts
 * import { identifyPrivyUser } from '@formo/analytics';
 *
 * const { user } = usePrivy();
 * const { wallets } = useWallets();
 * if (user) {
 *   // activeAddress is optional — omit it if the SDK already tracks the
 *   // connected wallet via a wagmi/EIP-1193 connect.
 *   await identifyPrivyUser(formo, user, {
 *     activeAddress: wallets[0]?.address,
 *   });
 * }
 * ```
 */
export async function identifyPrivyUser(
  analytics: IFormoAnalytics,
  user: PrivyUser,
  options: IdentifyPrivyUserOptions = {}
): Promise<void> {
  if (!analytics || !user) return;

  const { properties, wallets } = parsePrivyProperties(user);

  // identify() is keyed on a wallet address, so with no linked wallets there is
  // nothing to attach the Privy identity to. Log it so a walletless user (or a
  // pre-wallet account-creation flow) doesn't silently disappear.
  if (wallets.length === 0) {
    logger.info(
      "identifyPrivyUser: user has no linked wallets; nothing to identify",
      user.id
    );
    return;
  }

  const baseProperties: IFormoEventProperties = {
    ...properties,
    ...options.properties,
  };

  // Resolve the active/connected wallet (case-insensitive). Fall back to the
  // SDK's existing currentAddress (e.g. from a prior wagmi connect) so callers
  // that already track connects don't have to pass activeAddress. Only honored
  // if it actually matches one of the linked wallets.
  const activeAddress = (
    options.activeAddress ?? analytics.currentAddress
  )?.toLowerCase();
  const hasActive =
    !!activeAddress &&
    wallets.some((w) => w.address.toLowerCase() === activeAddress);

  // Order embedded (Privy) wallets first and external wallets last. When we
  // know the active wallet, move it to the very end. identify() is called in
  // order, so the last wallet flagged with setActive wins attribution.
  const embedded = wallets.filter((w) => w.isEmbedded);
  const external = wallets.filter((w) => !w.isEmbedded);
  let ordered: PrivyWalletInfo[] = [...embedded, ...external];
  if (hasActive) {
    const active = wallets.find(
      (w) => w.address.toLowerCase() === activeAddress
    )!;
    ordered = [
      ...ordered.filter((w) => w.address.toLowerCase() !== activeAddress),
      active,
    ];
  }

  const lastIndex = ordered.length - 1;

  for (let i = 0; i < ordered.length; i++) {
    const wallet = ordered[i];

    // The wallet that should own event attribution: the resolved active wallet
    // if known, otherwise the last wallet in embedded-first order (a best-effort
    // guess that prefers an external wallet over an embedded one).
    const isAttributionWallet = hasActive
      ? wallet.address.toLowerCase() === activeAddress
      : i === lastIndex;

    const walletProperties: IFormoEventProperties = {
      ...baseProperties,
      is_embedded: wallet.isEmbedded,
    };
    if (wallet.walletClient) walletProperties.wallet_client = wallet.walletClient;
    if (wallet.chainType) walletProperties.chain_type = wallet.chainType;

    await analytics.identify(
      {
        address: wallet.address,
        userId: user.id,
        setActive: isAttributionWallet,
      },
      walletProperties
    );
  }
}
