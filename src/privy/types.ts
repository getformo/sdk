/**
 * Privy-specific type definitions for user profile enrichment
 *
 * These types provide TypeScript interfaces for Privy user objects
 * from the Privy React SDK (`usePrivy()` hook).
 *
 * Based on the Privy user object structure:
 * https://docs.privy.io/user-management/users/the-user-object
 */

/**
 * Valid Privy linked account type strings.
 */
export type PrivyAccountType =
  | "email"
  | "phone"
  | "wallet"
  | "farcaster"
  | "telegram"
  | "apple_oauth"
  | "discord_oauth"
  | "github_oauth"
  | "google_oauth"
  | "instagram_oauth"
  | "linkedin_oauth"
  | "spotify_oauth"
  | "tiktok_oauth"
  | "twitter_oauth"
  | "line"
  | "custom_auth"
  | "passkey"
  | "cross_app"
  | string;

/**
 * A linked account entry from the Privy user object.
 * Each linked account has a `type` discriminator and type-specific fields.
 */
export interface PrivyLinkedAccount {
  type: PrivyAccountType;

  // Email / wallet address
  address?: string;

  // Phone number
  number?: string;

  // Social account fields
  username?: string;
  name?: string;
  displayName?: string;
  subject?: string;
  email?: string;

  // Wallet-specific fields
  chainType?: string;
  walletClient?: string;
  walletClientType?: string;
  connectorType?: string;
  delegated?: boolean;

  // Farcaster-specific fields
  fid?: number;
  ownerAddress?: string;
  bio?: string;
  pfp?: string;
  url?: string;
  signerPublicKey?: string;

  // Telegram-specific fields
  telegramUserId?: string;
  firstName?: string;
  lastName?: string;

  // Verification timestamps
  firstVerifiedAt?: number | null;
  latestVerifiedAt?: number | null;
  verifiedAt?: number | null;
}

/**
 * Privy user object as returned by the Privy React SDK.
 *
 * Convenience accessors: user.email, user.phone, user.wallet, user.discord,
 * user.twitter, user.farcaster, user.github, user.google, user.linkedin,
 * user.apple, user.instagram, user.spotify, user.tiktok, user.telegram, user.line
 */
export interface PrivyUser {
  /** Privy user ID in DID format (e.g., "did:privy:cm3np...") */
  id: string;

  /** Account creation timestamp */
  createdAt?: number;

  /** All linked accounts */
  linkedAccounts?: PrivyLinkedAccount[];

  /** Optional custom metadata */
  customMetadata?: Record<string, unknown>;

  // Convenience accessors for common account types
  email?: { address: string };
  phone?: { number: string };
  wallet?: {
    address: string;
    chainType?: string;
    walletClient?: string;
    walletClientType?: string;
    connectorType?: string;
  };
  google?: { email?: string; name?: string; subject?: string };
  discord?: { username?: string; subject?: string; email?: string };
  twitter?: {
    username?: string;
    name?: string;
    subject?: string;
    profilePictureUrl?: string;
  };
  farcaster?: {
    fid?: number;
    username?: string;
    displayName?: string;
    ownerAddress?: string;
    bio?: string;
    pfp?: string;
  };
  github?: { username?: string; name?: string; subject?: string };
  linkedin?: { email?: string; name?: string; subject?: string };
  apple?: { email?: string; subject?: string };
  instagram?: { username?: string; subject?: string };
  spotify?: { email?: string; name?: string; subject?: string };
  tiktok?: { username?: string; name?: string; subject?: string };
  line?: { email?: string; name?: string; subject?: string };
  telegram?: {
    telegramUserId?: string;
    username?: string;
    firstName?: string;
    lastName?: string;
  };

  /** MFA methods */
  mfaMethods?: Array<string>;

  /** Whether the user has accepted terms */
  hasAcceptedTerms?: boolean;

  /** Whether this is a guest user */
  isGuest?: boolean;
}

/**
 * Extracted profile properties from a Privy user.
 * These are the properties that get sent as event properties via `identify()`.
 */
export interface PrivyProfileProperties {
  privyDid: string;
  privyCreatedAt?: number;
  email?: string;
  apple?: string;
  discord?: string;
  twitter?: string;
  farcaster?: string;
  farcasterFid?: number;
  github?: string;
  google?: string;
  linkedin?: string;
  line?: string;
  spotify?: string;
  telegram?: string;
  tiktok?: string;
  instagram?: string;
  [key: string]: unknown;
}

/**
 * Wallet info extracted from Privy linked accounts.
 */
export interface PrivyWalletInfo {
  address: string;
  walletClient?: string;
  chainType?: string;
  isEmbedded: boolean;
}
