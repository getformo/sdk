/**
 * Solana Address Utilities
 *
 * Validation and formatting utilities for Solana public key addresses.
 * Solana addresses are base58-encoded Ed25519 public keys (32 bytes).
 */

import { Address } from "../types";

/**
 * Base58 alphabet used by Solana
 * Note: Excludes 0, O, I, l to avoid visual ambiguity
 */
const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Minimum length of a valid Solana address (base58-encoded 32 bytes)
 */
const MIN_SOLANA_ADDRESS_LENGTH = 32;

/**
 * Maximum length of a valid Solana address (base58-encoded 32 bytes)
 */
const MAX_SOLANA_ADDRESS_LENGTH = 44;

/**
 * Validates that a string is a valid base58 string
 * @param str The string to validate
 * @returns true if all characters are valid base58 characters
 */
const isValidBase58 = (str: string): boolean => {
  for (const char of str) {
    if (!BASE58_ALPHABET.includes(char)) {
      return false;
    }
  }
  return true;
};

/**
 * Checks if an address is a valid Solana address format.
 * Solana addresses are base58-encoded Ed25519 public keys (32 bytes),
 * which encode to 32-44 characters.
 *
 * @param address The address to validate
 * @returns true if the address is a valid Solana address format
 *
 * @example
 * ```typescript
 * isValidSolanaAddress("11111111111111111111111111111111"); // true (System Program)
 * isValidSolanaAddress("So11111111111111111111111111111112"); // true (Wrapped SOL)
 * isValidSolanaAddress("0x123..."); // false (EVM address)
 * isValidSolanaAddress("abc"); // false (too short)
 * ```
 */
export const isValidSolanaAddress = (
  address: Address | null | undefined
): address is Address => {
  if (typeof address !== "string") {
    return false;
  }

  const trimmed = address.trim();

  // Check length constraints
  if (
    trimmed.length < MIN_SOLANA_ADDRESS_LENGTH ||
    trimmed.length > MAX_SOLANA_ADDRESS_LENGTH
  ) {
    return false;
  }

  // Check all characters are valid base58
  return isValidBase58(trimmed);
};

/**
 * Validates and returns a trimmed valid Solana address.
 *
 * @param address The address to validate and trim
 * @returns The trimmed address if valid, null otherwise
 *
 * @example
 * ```typescript
 * getValidSolanaAddress("  So11111111111111111111111111111112  ");
 * // Returns: "So11111111111111111111111111111112"
 *
 * getValidSolanaAddress("invalid");
 * // Returns: null
 * ```
 */
export const getValidSolanaAddress = (
  address: Address | null | undefined
): string | null => {
  if (typeof address !== "string") {
    return null;
  }

  const trimmed = address.trim();

  if (isValidSolanaAddress(trimmed)) {
    return trimmed;
  }

  return null;
};

/**
 * Known Solana program addresses that should be blocked from analytics
 * (similar to EVM zero address and dead address)
 */
const BLOCKED_SOLANA_ADDRESSES = [
  // System Program
  "11111111111111111111111111111111",
] as const;

/**
 * Checks if a Solana address is in the blocked list.
 * Blocked addresses include system programs that are not user addresses.
 *
 * @param address The address to check
 * @returns true if the address is blocked, false otherwise
 */
export const isBlockedSolanaAddress = (
  address: Address | null | undefined
): boolean => {
  const validAddress = getValidSolanaAddress(address);
  if (!validAddress) {
    return false;
  }

  return BLOCKED_SOLANA_ADDRESSES.includes(
    validAddress as (typeof BLOCKED_SOLANA_ADDRESSES)[number]
  );
};

/**
 * Detects if an address is a Solana address vs an EVM address.
 * Solana addresses are base58-encoded, while EVM addresses start with "0x".
 *
 * @param address The address to check
 * @returns "solana" if it's a Solana address, "evm" if EVM, or null if invalid
 *
 * @example
 * ```typescript
 * detectAddressType("So11111111111111111111111111111112"); // "solana"
 * detectAddressType("0x742d35Cc6634C0532925a3b844Bc9e7595f..."); // "evm"
 * detectAddressType("invalid"); // null
 * ```
 */
export const detectAddressType = (
  address: Address | null | undefined
): "solana" | "evm" | null => {
  if (typeof address !== "string") {
    return null;
  }

  const trimmed = address.trim();

  // EVM addresses start with 0x and are 42 characters (0x + 40 hex chars)
  if (trimmed.startsWith("0x") && trimmed.length === 42) {
    // Validate it's all hex after 0x
    const hexPart = trimmed.slice(2);
    if (/^[0-9a-fA-F]+$/.test(hexPart)) {
      return "evm";
    }
  }

  // Check if it's a valid Solana address
  if (isValidSolanaAddress(trimmed)) {
    return "solana";
  }

  return null;
};

/**
 * Shortens a Solana address for display purposes.
 *
 * @param address The address to shorten
 * @param startChars Number of characters to show at the start (default: 4)
 * @param endChars Number of characters to show at the end (default: 4)
 * @returns Shortened address like "So11...1112" or the original if invalid
 *
 * @example
 * ```typescript
 * shortenSolanaAddress("So11111111111111111111111111111112");
 * // Returns: "So11...1112"
 * ```
 */
export const shortenSolanaAddress = (
  address: Address | null | undefined,
  startChars = 4,
  endChars = 4
): string => {
  const validAddress = getValidSolanaAddress(address);
  if (!validAddress) {
    return address || "";
  }

  if (validAddress.length <= startChars + endChars + 3) {
    return validAddress;
  }

  return `${validAddress.slice(0, startChars)}...${validAddress.slice(-endChars)}`;
};
