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

/** A 0x-prefixed 20-byte hex string (prefix and hex are case-insensitive). */
const EVM_ADDRESS_RE = /^0x[0-9a-f]{40}$/i;

/**
 * Compare two wallet addresses for equality. EVM addresses are hex and
 * case-insensitive, so they are folded to lowercase; all other chains (notably
 * Solana, whose Base58 addresses are case-sensitive) are compared exactly, so a
 * case difference never matches the wrong wallet.
 */
function sameAddress(a: string, b: string): boolean {
  return EVM_ADDRESS_RE.test(a) && EVM_ADDRESS_RE.test(b)
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
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
   * Optional override for the wallet that should own event attribution — the
   * one promoted to the SDK's current address/user, while every other linked
   * wallet is recorded only for clustering.
   *
   * You usually don't need this. When omitted, the helper defaults to Privy's
   * own surfaced wallet (`user.wallet`), then to a best-effort guess (embedded
   * wallets deprioritized, so the last external wallet). Pass it only when you
   * want to pin attribution to a specific wallet — e.g. the currently connected
   * wallet from `useWallets()[0]?.address` or your wagmi account, which reflects
   * the live active wallet more precisely than `user.wallet`.
   *
   * Matched strictly: if it doesn't correspond to one of the user's linked
   * wallets, no wallet is promoted and the SDK's current wallet is left as-is
   * (so a connected wallet that isn't linked in Privy is preserved).
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
 * Attribution: only the active wallet (see
 * {@link IdentifyPrivyUserOptions.activeAddress}) promotes the SDK's current
 * address/user; every other linked wallet is recorded purely for clustering and
 * does not repoint attribution. Because the clustering identifies don't touch
 * active state, a connected wallet that isn't linked in Privy is left untouched
 * rather than overwritten. This does not change the public `identify()` API.
 *
 * Before emitting, it reconciles the SDK's chain id with the active wallet's
 * chain namespace (clearing a stale EVM chain id when a Solana wallet becomes
 * active, and vice versa), so identifies aren't dropped by an `excludeChains`
 * gate and later events aren't paired with the wrong chain. This happens here,
 * so the direct helper and the `formo.identify(user, { privy: true })` form
 * behave identically.
 *
 * Returns the active linked wallet's `{ address, chainType }` (the one now
 * owning attribution), or `undefined` when no linked wallet matched the
 * requested active address (or the user had no wallets).
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
): Promise<{ address: string; chainType?: string } | undefined> {
  if (!analytics || !user) return undefined;

  const { properties, wallets } = parsePrivyProperties(user);

  // identify() is keyed on a wallet address, so with no linked wallets there is
  // nothing to attach the Privy identity to. Log it so a walletless user (or a
  // pre-wallet account-creation flow) doesn't silently disappear.
  if (wallets.length === 0) {
    logger.info(
      "identifyPrivyUser: user has no linked wallets; nothing to identify",
      user.id
    );
    return undefined;
  }

  const baseProperties: IFormoEventProperties = {
    ...properties,
    ...options.properties,
  };

  const target = analytics as unknown as PrivySyncTarget;

  // Resolve the wallet that should own attribution. An explicit activeAddress
  // wins; otherwise fall back to the address Formo already treats as active
  // (e.g. from a wagmi/EIP-1193 connect) BEFORE user.wallet, so the direct
  // identifyPrivyUser() form preserves a connected wallet exactly like the
  // identify(user,{privy:true}) form. A connected wallet that isn't linked here
  // simply doesn't match, leaving attribution untouched.
  const activeWallet = resolveActiveWallet(
    wallets,
    options.activeAddress ?? target.currentAddress,
    user.wallet?.address
  );

  // Reconcile the chain BEFORE emitting any identify. identify() runs each event
  // through the tracking gate (which enforces `excludeChains` against the
  // current chain id); if the active wallet is on a different chain namespace
  // than the stale current chain id (e.g. a Solana wallet while an EVM chain was
  // current, and that EVM chain is excluded), reconciling first prevents the
  // clustering identifies from being silently dropped. Doing it here — rather
  // than in the identify(user,{privy:true}) dispatch — means the direct
  // identifyPrivyUser() entry point gets the same treatment.
  target.syncPrivyActiveChain?.(activeWallet?.chainType);

  // Emit an identify for every linked wallet under the shared DID. Only the
  // active wallet promotes the SDK's active identity (via the internal
  // setActive flag); the rest are recorded purely for clustering and never
  // repoint attribution — so ordering is irrelevant, and a connected wallet
  // that isn't linked here (activeWallet === undefined) leaves the SDK's
  // current address/user untouched instead of being overwritten.
  const identify = target.identify.bind(analytics);
  for (const wallet of wallets) {
    const walletProperties: IFormoEventProperties = {
      ...baseProperties,
      is_embedded: wallet.isEmbedded,
    };
    if (wallet.walletClient) walletProperties.wallet_client = wallet.walletClient;
    if (wallet.chainType) walletProperties.chain_type = wallet.chainType;

    await identify(
      {
        address: wallet.address,
        userId: user.id,
        setActive: wallet === activeWallet,
      },
      walletProperties
    );
  }

  return activeWallet
    ? { address: activeWallet.address, chainType: activeWallet.chainType }
    : undefined;
}

/**
 * Internal capabilities of the analytics instance that `identifyPrivyUser` uses
 * but that are not part of the public {@link IFormoAnalytics} contract:
 * `identify` with the `setActive` flag (clustering identifies that don't repoint
 * attribution), `syncPrivyActiveChain` (reconcile the chain id with the active
 * wallet's namespace), and read access to `currentAddress` (the wallet Formo
 * already treats as active). All optional so a minimal stub still works.
 */
interface PrivySyncTarget {
  readonly currentAddress?: string;
  identify: (
    params: { address: string; userId?: string; setActive?: boolean },
    properties?: IFormoEventProperties
  ) => Promise<void>;
  syncPrivyActiveChain?(chainType?: string): void;
}

/**
 * Choose the linked wallet that should own event attribution.
 *
 * An explicit `activeAddress` (a caller override, or the SDK's already-connected
 * wallet) is matched strictly and never falls back: a connected wallet that is
 * not in `linkedAccounts` resolves to `undefined`, so the sync leaves the
 * current wallet untouched. With no active address, prefer Privy's surfaced
 * primary (`user.wallet`), then a best-effort guess (embedded wallets first, so
 * the last external wallet). Address comparison is chain-appropriate so Solana
 * casing isn't mismatched.
 */
function resolveActiveWallet(
  wallets: PrivyWalletInfo[],
  activeAddress?: string,
  primaryAddress?: string
): PrivyWalletInfo | undefined {
  if (activeAddress) {
    return wallets.find((w) => sameAddress(w.address, activeAddress));
  }
  if (primaryAddress) {
    const primary = wallets.find((w) => sameAddress(w.address, primaryAddress));
    if (primary) return primary;
  }
  const external = wallets.filter((w) => !w.isEmbedded);
  return external.length > 0
    ? external[external.length - 1]
    : wallets[wallets.length - 1];
}
