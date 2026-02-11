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
 * Supports both Privy SDK (camelCase) and REST API (snake_case) formats.
 *
 * @param user - The Privy user object from `usePrivy()` or the Privy API
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
  // Support both SDK (camelCase) and API (snake_case) linked_accounts
  const accounts = user.linkedAccounts || user.linked_accounts || [];
  const createdAt = user.createdAt ?? user.created_at;
  const isGuest = user.isGuest ?? user.is_guest;
  const mfaCount = user.mfaMethods?.length ?? user.mfa_methods?.length ?? 0;

  const properties: PrivyProfileProperties = {
    privyDid: user.id,
    privyCreatedAt: createdAt,
    linkedAccountTypes: getLinkedAccountTypes(accounts),
    linkedAccounts: summarizeLinkedAccounts(accounts),
    walletCount: countWallets(accounts),
    hasEmbeddedWallet: hasEmbeddedWallet(accounts),
    hasMfa: mfaCount > 0,
  };

  // Email
  if (user.email?.address) {
    properties.email = user.email.address;
  }

  // Phone
  if (user.phone?.number) {
    properties.phone = user.phone.number;
  }

  // Guest status
  if (isGuest !== undefined) {
    properties.isGuest = isGuest;
  }

  // Social accounts - extract usernames/identifiers
  // Matches all convenience accessors from the Privy user object:
  // https://docs.privy.io/user-management/users/the-user-object

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

  if (!properties.email) {
    const emailAccount = accounts.find((account) => account.type === "email");
    if (emailAccount?.address) {
      properties.email = emailAccount.address;
    } else if (emailAccount?.email) {
      properties.email = emailAccount.email;
    }
  }

  if (!properties.phone) {
    const phoneAccount = accounts.find((account) => account.type === "phone");
    if (phoneAccount?.number) {
      properties.phone = phoneAccount.number;
    }
  }

  if (!properties.apple) {
    const appleAccount = accounts.find(
      (account) => account.type === "apple_oauth"
    );
    if (appleAccount?.email) {
      properties.apple = appleAccount.email;
    } else if (appleAccount?.address) {
      properties.apple = appleAccount.address;
    }
  }

  if (!properties.discord) {
    const discordAccount = accounts.find(
      (account) => account.type === "discord_oauth"
    );
    if (discordAccount?.username) {
      properties.discord = discordAccount.username;
    } else if (discordAccount?.email) {
      properties.discord = discordAccount.email;
    } else if (discordAccount?.name) {
      properties.discord = discordAccount.name;
    }
  }

  if (!properties.farcaster) {
    const farcasterAccount = accounts.find(
      (account) => account.type === "farcaster"
    );
    if (farcasterAccount?.username) {
      properties.farcaster = farcasterAccount.username;
    } else if (farcasterAccount?.displayName) {
      properties.farcaster = farcasterAccount.displayName;
    } else if (farcasterAccount?.display_name) {
      properties.farcaster = farcasterAccount.display_name;
    }
    if (!properties.farcasterFid && farcasterAccount?.fid) {
      properties.farcasterFid = farcasterAccount.fid;
    }
  }

  if (!properties.github) {
    const githubAccount = accounts.find(
      (account) => account.type === "github_oauth"
    );
    if (githubAccount?.username) {
      properties.github = githubAccount.username;
    } else if (githubAccount?.name) {
      properties.github = githubAccount.name;
    }
  }

  if (!properties.google) {
    const googleAccount = accounts.find(
      (account) => account.type === "google_oauth"
    );
    if (googleAccount?.email) {
      properties.google = googleAccount.email;
    }
  }

  if (!properties.instagram) {
    const instagramAccount = accounts.find(
      (account) => account.type === "instagram_oauth"
    );
    if (instagramAccount?.username) {
      properties.instagram = instagramAccount.username;
    }
  }

  if (!properties.line) {
    const lineAccount = accounts.find((account) => account.type === "line");
    if (lineAccount?.email) {
      properties.line = lineAccount.email;
    }
  }

  if (!properties.linkedin) {
    const linkedinAccount = accounts.find(
      (account) => account.type === "linkedin_oauth"
    );
    if (linkedinAccount?.email) {
      properties.linkedin = linkedinAccount.email;
    }
  }

  if (!properties.spotify) {
    const spotifyAccount = accounts.find(
      (account) => account.type === "spotify_oauth"
    );
    if (spotifyAccount?.email) {
      properties.spotify = spotifyAccount.email;
    }
  }

  if (!properties.telegram) {
    const telegramAccount = accounts.find(
      (account) => account.type === "telegram"
    );
    if (telegramAccount?.username) {
      properties.telegram = telegramAccount.username;
    } else if (telegramAccount?.telegramUserId) {
      properties.telegram = telegramAccount.telegramUserId;
    } else if (telegramAccount?.telegram_user_id) {
      properties.telegram = telegramAccount.telegram_user_id;
    }
  }

  if (!properties.tiktok) {
    const tiktokAccount = accounts.find(
      (account) => account.type === "tiktok_oauth"
    );
    if (tiktokAccount?.username) {
      properties.tiktok = tiktokAccount.username;
    }
  }

  if (!properties.twitter) {
    const twitterAccount = accounts.find(
      (account) => account.type === "twitter_oauth"
    );
    if (twitterAccount?.username) {
      properties.twitter = twitterAccount.username;
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
 * Extracts only the essential identifiers (type, address/username, wallet info).
 */
function summarizeLinkedAccounts(
  accounts: PrivyLinkedAccount[]
): PrivyLinkedAccountSummary[] {
  return accounts.map((account) => {
    const summary: PrivyLinkedAccountSummary = {
      type: account.type,
    };

    // Address (for email and wallet types)
    if (account.address) {
      summary.address = account.address;
    }

    // Username (for social account types)
    if (account.username) {
      summary.username = account.username;
    }

    // Wallet-specific fields (support both naming conventions)
    const walletClient =
      account.walletClientType ||
      account.walletClient ||
      account.wallet_client_type ||
      account.wallet_client;
    if (walletClient) {
      summary.walletClient = walletClient;
    }

    const chainType = account.chainType || account.chain_type;
    if (chainType) {
      summary.chainType = chainType;
    }

    // Farcaster FID
    if (account.fid) {
      summary.fid = account.fid;
    }

    // Verified status
    // Use null check to handle timestamp of 0 correctly
    const verifiedAt = account.verifiedAt ?? account.verified_at;
    if (verifiedAt != null) {
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
      (a.walletClientType === "privy" ||
        a.walletClient === "privy" ||
        a.wallet_client_type === "privy" ||
        a.wallet_client === "privy")
  );
}
