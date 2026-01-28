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
 *   const properties = extractPrivyProperties(user);
 *   formo.identify({ address: user.wallet?.address, userId: user.id }, properties);
 * }
 * ```
 */
export function extractPrivyProperties(
  user: PrivyUser
): PrivyProfileProperties {
  // Support both SDK (camelCase) and API (snake_case) linked_accounts
  const accounts = user.linked_accounts || user.linkedAccounts || [];

  const properties: PrivyProfileProperties = {
    privyDid: user.id,
    privyCreatedAt: user.created_at,
    linkedAccountTypes: getLinkedAccountTypes(accounts),
    linkedAccounts: summarizeLinkedAccounts(accounts),
    walletCount: countWallets(accounts),
    hasEmbeddedWallet: hasEmbeddedWallet(accounts),
    hasMfa: (user.mfa_methods?.length ?? 0) > 0,
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
  if (user.is_guest !== undefined) {
    properties.isGuest = user.is_guest;
  }

  // Social accounts - extract usernames/identifiers
  if (user.discord?.username) {
    properties.discordUsername = user.discord.username;
  }

  if (user.twitter?.username) {
    properties.twitterUsername = user.twitter.username;
  }

  if (user.farcaster?.username) {
    properties.farcasterUsername = user.farcaster.username;
  }

  if (user.farcaster?.fid) {
    properties.farcasterFid = user.farcaster.fid;
  }

  if (user.github?.username) {
    properties.githubUsername = user.github.username;
  }

  if (user.google?.email) {
    properties.googleEmail = user.google.email;
  }

  if (user.linkedin?.email) {
    properties.linkedinEmail = user.linkedin.email;
  }

  if (user.telegram?.username) {
    properties.telegramUsername = user.telegram.username;
  }

  if (user.instagram?.username) {
    properties.instagramUsername = user.instagram.username;
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
      account.wallet_client ||
      account.walletClient ||
      account.wallet_client_type ||
      account.walletClientType;
    if (walletClient) {
      summary.walletClient = walletClient;
    }

    const chainType = account.chain_type || account.chainType;
    if (chainType) {
      summary.chainType = chainType;
    }

    // Farcaster FID
    if (account.fid) {
      summary.fid = account.fid;
    }

    // Verified status
    const verifiedAt =
      account.verified_at || account.verifiedAt;
    if (verifiedAt) {
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
      (a.wallet_client === "privy" ||
        a.wallet_client_type === "privy" ||
        a.walletClient === "privy" ||
        a.walletClientType === "privy")
  );
}
