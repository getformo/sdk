/**
 * Privy-specific type definitions for user profile enrichment
 *
 * These types provide TypeScript interfaces for Privy user objects,
 * allowing the SDK to extract and map Privy user data to wallet profile properties.
 *
 * Supports both the Privy React SDK (camelCase) and REST API (snake_case) formats.
 *
 * Based on the Privy user object structure:
 * https://docs.privy.io/user-management/users/the-user-object
 */

/**
 * Valid Privy linked account type strings.
 * The API uses types like "email", "phone", "wallet", "farcaster",
 * "discord_oauth", "twitter_oauth", "google_oauth", "github_oauth", etc.
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
 *
 * Supports both SDK (camelCase) and API (snake_case) field naming.
 */
export interface PrivyLinkedAccount {
  /** Account type discriminator */
  type: PrivyAccountType;

  // Email / wallet address
  address?: string;

  // Phone number
  number?: string;

  // Social account fields
  username?: string;
  name?: string;
  /** API format (snake_case) */
  display_name?: string;
  /** SDK format (camelCase) */
  displayName?: string;
  subject?: string;
  email?: string;

  // Wallet-specific fields
  /** API format */
  chain_type?: string;
  /** SDK format */
  chainType?: string;
  /** API format */
  wallet_client?: string;
  /** SDK format */
  walletClient?: string;
  /** API format */
  wallet_client_type?: string;
  /** SDK format */
  walletClientType?: string;
  /** API format */
  connector_type?: string;
  /** SDK format */
  connectorType?: string;
  /** Whether server sessions are enabled for this wallet */
  delegated?: boolean;

  // Farcaster-specific fields
  fid?: number;
  /** API format */
  owner_address?: string;
  /** SDK format */
  ownerAddress?: string;
  bio?: string;
  pfp?: string;
  url?: string;
  /** API format */
  signer_public_key?: string;
  /** SDK format */
  signerPublicKey?: string;

  // Telegram-specific fields
  /** API format */
  telegram_user_id?: string;
  /** SDK format */
  telegramUserId?: string;
  first_name?: string;
  last_name?: string;

  // Verification timestamps
  /** API format */
  first_verified_at?: number | null;
  /** SDK format */
  firstVerifiedAt?: number | null;
  /** API format */
  latest_verified_at?: number | null;
  /** SDK format */
  latestVerifiedAt?: number | null;
  /** API format */
  verified_at?: number | null;
  /** SDK format */
  verifiedAt?: number | null;
}

/**
 * Privy user object as returned by the Privy SDK or API.
 *
 * The Privy React SDK uses camelCase (`linkedAccounts`, `createdAt`, `mfaMethods`),
 * while the REST API uses snake_case (`linked_accounts`, `created_at`, `mfa_methods`).
 * Both formats are supported.
 *
 * Convenience accessors: user.email, user.phone, user.wallet, user.discord,
 * user.twitter, user.farcaster, user.github, user.google, user.linkedin,
 * user.apple, user.instagram, user.spotify, user.tiktok, user.telegram, user.line
 */
export interface PrivyUser {
  /** Privy user ID in DID format (e.g., "did:privy:cm3np...") */
  id: string;

  /** Account creation timestamp — SDK camelCase */
  createdAt?: number;
  /** Account creation timestamp — API snake_case */
  created_at?: number;

  /** All linked accounts — SDK camelCase */
  linkedAccounts?: PrivyLinkedAccount[];
  /** All linked accounts — API snake_case */
  linked_accounts?: PrivyLinkedAccount[];

  /** Optional custom metadata — SDK camelCase */
  customMetadata?: Record<string, unknown>;
  /** Optional custom metadata — API snake_case */
  custom_metadata?: Record<string, unknown>;

  // Convenience accessors for common account types
  email?: { address: string };
  phone?: { number: string };
  wallet?: {
    address: string;
    chainType?: string;
    chain_type?: string;
    walletClient?: string;
    wallet_client?: string;
    walletClientType?: string;
    wallet_client_type?: string;
    connectorType?: string;
    connector_type?: string;
  };
  google?: { email?: string; name?: string; subject?: string };
  discord?: { username?: string; subject?: string; email?: string };
  twitter?: {
    username?: string;
    name?: string;
    subject?: string;
    profilePictureUrl?: string;
    profile_picture_url?: string;
  };
  farcaster?: {
    fid?: number;
    username?: string;
    displayName?: string;
    display_name?: string;
    ownerAddress?: string;
    owner_address?: string;
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
    telegram_user_id?: string;
    username?: string;
    firstName?: string;
    first_name?: string;
    lastName?: string;
    last_name?: string;
  };

  /** MFA methods — SDK camelCase */
  mfaMethods?: Array<string>;
  /** MFA methods — API snake_case */
  mfa_methods?: Array<{ type: string }>;

  /** Whether the user has accepted terms — SDK camelCase */
  hasAcceptedTerms?: boolean;
  /** Whether the user has accepted terms — API snake_case */
  has_accepted_terms?: boolean;

  /** Whether this is a guest user — SDK camelCase */
  isGuest?: boolean;
  /** Whether this is a guest user — API snake_case */
  is_guest?: boolean;
}

/**
 * Extracted profile properties from a Privy user.
 * These are the properties that get sent as event properties via `identify()`.
 */
export interface PrivyProfileProperties {
  privyDid: string;
  privyCreatedAt?: number;
  email?: string;
  phone?: string;
  linkedAccountTypes: string[];
  linkedAccounts: PrivyLinkedAccountSummary[];
  walletCount: number;
  hasEmbeddedWallet: boolean;
  isGuest?: boolean;
  hasMfa: boolean;
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
 * Summarized linked account for analytics.
 * Contains the essential identifiers without sensitive or verbose fields.
 */
export interface PrivyLinkedAccountSummary {
  type: string;
  address?: string;
  username?: string;
  walletClient?: string;
  chainType?: string;
  fid?: number;
  verified?: boolean;
}
