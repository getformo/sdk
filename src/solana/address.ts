/**
 * Solana address validation utilities
 *
 * Solana uses Base58 encoded 32-byte public keys as addresses.
 * Format: FDKJvWcJNe6wecbgDYDFPCfgs14aJnVsUfWQRYWLn4Tn (32-44 characters)
 *
 * @see https://solana.com/developers/courses/intro-to-solana/interact-with-wallets
 */

import { SolanaPublicKey } from "./types";

/**
 * Base58 alphabet used by Solana (Bitcoin alphabet)
 */
const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Set for O(1) lookup of valid Base58 characters
 */
const BASE58_CHAR_SET = new Set(BASE58_ALPHABET);

/**
 * Minimum length of a Solana address (Base58 encoded)
 * A 32-byte key will be at least 32 characters when Base58 encoded
 */
const MIN_SOLANA_ADDRESS_LENGTH = 32;

/**
 * Maximum length of a Solana address (Base58 encoded)
 * A 32-byte key will be at most 44 characters when Base58 encoded
 */
const MAX_SOLANA_ADDRESS_LENGTH = 44;

/**
 * System program addresses and other special Solana addresses
 * These are valid addresses but may not represent user wallets
 */
export const SOLANA_SYSTEM_ADDRESSES = {
  SYSTEM_PROGRAM: "11111111111111111111111111111111",
  TOKEN_PROGRAM: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  TOKEN_2022_PROGRAM: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  ASSOCIATED_TOKEN_PROGRAM: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  RENT_SYSVAR: "SysvarRent111111111111111111111111111111111",
  CLOCK_SYSVAR: "SysvarC1ock11111111111111111111111111111111",
} as const;

/**
 * Check if a string contains only valid Base58 characters
 */
function isValidBase58String(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    if (!BASE58_CHAR_SET.has(str[i])) {
      return false;
    }
  }
  return true;
}

/**
 * Check if a string is a valid Solana address format
 *
 * This performs format validation only (length and character set).
 * It does NOT validate that the address is a valid point on the Ed25519 curve.
 *
 * @param value The value to check
 * @returns true if the value is a valid Solana address format
 */
export function isSolanaAddress(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }

  const trimmed = value.trim();

  // Check length bounds
  if (
    trimmed.length < MIN_SOLANA_ADDRESS_LENGTH ||
    trimmed.length > MAX_SOLANA_ADDRESS_LENGTH
  ) {
    return false;
  }

  // Check character set (Base58)
  return isValidBase58String(trimmed);
}

/**
 * Get a valid Solana address from a string or PublicKey
 *
 * @param address The address to validate (string or PublicKey)
 * @returns The address string if valid, null otherwise
 */
export function getValidSolanaAddress(
  address: string | SolanaPublicKey | null | undefined
): string | null {
  if (!address) {
    return null;
  }

  // Handle PublicKey objects
  if (typeof address === "object" && "toBase58" in address) {
    try {
      const base58 = address.toBase58();
      return isSolanaAddress(base58) ? base58 : null;
    } catch {
      return null;
    }
  }

  // Handle strings
  if (typeof address === "string") {
    const trimmed = address.trim();
    return isSolanaAddress(trimmed) ? trimmed : null;
  }

  return null;
}

/**
 * Check if a Solana address is a system program or well-known program address
 *
 * @param address The address to check
 * @returns true if the address is a system/program address
 */
export function isSolanaSystemAddress(address: string): boolean {
  const validAddress = getValidSolanaAddress(address);
  if (!validAddress) {
    return false;
  }

  return Object.values(SOLANA_SYSTEM_ADDRESSES).includes(
    validAddress as (typeof SOLANA_SYSTEM_ADDRESSES)[keyof typeof SOLANA_SYSTEM_ADDRESSES]
  );
}

/**
 * Check if a Solana address is blocked (should not emit events)
 *
 * For Solana, we block system program addresses as they don't represent user wallets.
 *
 * @param address The address to check
 * @returns true if the address should be blocked
 */
export function isBlockedSolanaAddress(
  address: string | SolanaPublicKey | null | undefined
): boolean {
  const validAddress = getValidSolanaAddress(address);
  if (!validAddress) {
    return false;
  }

  // Block system addresses
  if (isSolanaSystemAddress(validAddress)) {
    return true;
  }

  // Block all-ones address (similar to zero address in EVM)
  if (validAddress === SOLANA_SYSTEM_ADDRESSES.SYSTEM_PROGRAM) {
    return true;
  }

  return false;
}

/**
 * Convert a Solana PublicKey to a string address
 *
 * @param publicKey The public key to convert
 * @returns The Base58 encoded address string, or null if invalid
 */
export function publicKeyToAddress(
  publicKey: SolanaPublicKey | null | undefined
): string | null {
  if (!publicKey) {
    return null;
  }

  try {
    const address = publicKey.toBase58();
    return isSolanaAddress(address) ? address : null;
  } catch {
    return null;
  }
}

/**
 * Check if two Solana addresses are equal (case-sensitive comparison)
 *
 * Unlike EVM addresses, Solana addresses are case-sensitive Base58.
 *
 * @param address1 First address
 * @param address2 Second address
 * @returns true if addresses are equal
 */
export function areSolanaAddressesEqual(
  address1: string | SolanaPublicKey | null | undefined,
  address2: string | SolanaPublicKey | null | undefined
): boolean {
  const addr1 = getValidSolanaAddress(address1);
  const addr2 = getValidSolanaAddress(address2);

  if (!addr1 || !addr2) {
    return false;
  }

  // Solana addresses are case-sensitive
  return addr1 === addr2;
}
