/**
 * Utility functions for extracting profile properties from Privy user objects.
 */

import {
  PrivyLinkedAccount,
  PrivyLinkedAccountSummary,
  PrivyProfileProperties,
  PrivyUser,
} from "./types";

/**
 * Extract wallet profile properties from a Privy user object.
 *
 * Maps Privy user data (email, phone, social accounts, wallets, etc.)
 * into a flat property object suitable for use with `identify()`.
 * Includes a `linkedAccounts` summary array with essential identifiers
 * for each linked account.
 *
 * @param user - The Privy user object from `usePrivy()`
 * @returns A flat object of profile properties
 *
 * @example
 * ```ts
 * const { user } = usePrivy();
 * if (user) {
 *   formo.identify(
 *     { address: user.wallet?.address, userId: user.id },
 *     extractPrivyProperties(user)
 *   );
 * }
 * ```
 */
export function extractPrivyProperties(
  user: PrivyUser
): PrivyProfileProperties {
  const accounts = user.linkedAccounts || [];

  const properties: PrivyProfileProperties = {
    privyDid: user.id,
    privyCreatedAt: user.createdAt,
    linkedAccountTypes: getLinkedAccountTypes(accounts),
    linkedAccounts: summarizeLinkedAccounts(accounts),
    walletCount: countWallets(accounts),
    hasEmbeddedWallet: hasEmbeddedWallet(accounts),
    hasMfa: (user.mfaMethods?.length ?? 0) > 0,
  };

  // Email
  if (user.email?.address) {
    properties.email = user.email.address;
  }

  // Guest status
  if (user.isGuest !== undefined) {
    properties.isGuest = user.isGuest;
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

  if (user.farcaster?.fid) {
    properties.farcasterFid = user.farcaster.fid;
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
    if (!properties.farcasterFid && farcasterAccount?.fid) {
      properties.farcasterFid = farcasterAccount.fid;
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
    const lineAccount = accounts.find((a) => a.type === "line");
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

  return properties;
}

/**
 * Get unique linked account types from a user's linked accounts.
 */
function getLinkedAccountTypes(accounts: PrivyLinkedAccount[]): string[] {
  return Array.from(new Set(accounts.map((a) => a.type)));
}

/**
 * Summarize linked accounts into a compact format for analytics.
 */
function summarizeLinkedAccounts(
  accounts: PrivyLinkedAccount[]
): PrivyLinkedAccountSummary[] {
  return accounts.map((account) => {
    const summary: PrivyLinkedAccountSummary = {
      type: account.type,
    };

    if (account.address) {
      summary.address = account.address;
    }

    if (account.username) {
      summary.username = account.username;
    }

    if (account.walletClientType || account.walletClient) {
      summary.walletClient = account.walletClientType || account.walletClient;
    }

    if (account.chainType) {
      summary.chainType = account.chainType;
    }

    if (account.fid) {
      summary.fid = account.fid;
    }

    if (account.verifiedAt != null) {
      summary.verified = true;
    }

    return summary;
  });
}

/**
 * Count the number of wallet-type linked accounts.
 */
function countWallets(accounts: PrivyLinkedAccount[]): number {
  return accounts.filter((a) => a.type === "wallet").length;
}

/**
 * Check if the user has a Privy embedded wallet.
 */
function hasEmbeddedWallet(accounts: PrivyLinkedAccount[]): boolean {
  return accounts.some(
    (a) =>
      a.type === "wallet" &&
      (a.walletClientType === "privy" || a.walletClient === "privy")
  );
}
