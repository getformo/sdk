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
  | "smart_wallet"
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
  | "twitch_oauth"
  | "line_oauth"
  | "custom_auth"
  | "passkey"
  | "cross_app"
  | "guest"
  | string;

/**
 * A linked account entry from the Privy user object.
 * Each linked account has a `type` discriminator and type-specific fields.
 */
export interface PrivyLinkedAccount {
  type: PrivyAccountType;

  // Email / wallet address
  address?: string | null;

  // Phone number
  number?: string | null;

  // Social account fields
  username?: string | null;
  name?: string | null;
  displayName?: string | null;
  subject?: string | null;
  email?: string | null;

  // Wallet-specific fields
  chainType?: string | null;
  walletClient?: string | null;
  walletClientType?: string | null;
  connectorType?: string | null;
  delegated?: boolean;

  // Farcaster-specific fields
  fid?: number | null;
  ownerAddress?: string | null;
  bio?: string | null;
  pfp?: string | null;
  url?: string | null;
  signerPublicKey?: string | null;

  // Telegram-specific fields
  telegramUserId?: string | null;
  firstName?: string | null;
  lastName?: string | null;

  // Verification timestamps
  firstVerifiedAt?: Date | null;
  latestVerifiedAt?: Date | null;
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
  createdAt?: Date;

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
  google?: { subject: string; email: string; name: string | null };
  discord?: { subject: string; username: string | null; email: string | null };
  twitter?: {
    subject: string;
    username: string | null;
    name: string | null;
    profilePictureUrl: string | null;
  };
  farcaster?: {
    fid: number | null;
    ownerAddress: string;
    username: string | null;
    displayName: string | null;
    bio: string | null;
    pfp: string | null;
  };
  github?: { subject: string; username: string | null; name: string | null };
  linkedin?: { subject: string; name: string | null; email: string | null; vanityName: string | null };
  apple?: { subject: string; email: string };
  instagram?: { subject: string; username: string | null };
  spotify?: { subject: string; email: string | null; name: string | null };
  tiktok?: { subject: string; username: string | null; name: string | null };
  line?: { subject: string; name: string | null; email: string | null };
  telegram?: {
    telegramUserId: string;
    firstName: string | null;
    lastName: string | null;
    username: string | null;
    photoUrl: string | null;
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
