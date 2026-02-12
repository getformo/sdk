import { Address } from "../types";
import { keccak256 } from "ethereum-cryptography/keccak.js";
import { utf8ToBytes } from "ethereum-cryptography/utils.js";
import {
  ensureIfUint8Array,
  isAddress,
  uint8ArrayToHexString,
} from "../validators";
import { isNullish } from "../validators/object";
import { BLOCKED_ADDRESSES } from "../constants";
import { isSolanaAddress, getValidSolanaAddress } from "../solana/address";
import { SOLANA_CHAIN_IDS } from "../solana/types";

/**
 * Private helper function to validate and trim an address
 * @param address The address to validate and trim
 * @returns The trimmed address if valid, null otherwise
 */
const _validateAndTrimAddress = (address: Address | null | undefined): string | null => {
  if (typeof address === "string" && address.trim() !== "" && isAddress(address.trim())) {
    return address.trim();
  }
  return null;
};

/**
 * Type guard to check if an address is valid and non-empty after trimming.
 * Note: This function checks if the trimmed value of the address is valid, but does not guarantee that the input address itself is trimmed.
 * If you require a trimmed address, use `getValidAddress(address)` to obtain the trimmed value.
 * @param address The address to validate
 * @returns true if the trimmed address is valid and non-empty, false otherwise.
 * @remarks
 * This type guard only ensures that the trimmed value is a valid Address. The original input may still contain leading or trailing whitespace.
 */
export const isValidAddress = (address: Address | null | undefined): address is Address => {
  return _validateAndTrimAddress(address) !== null;
};

/**
 * Validates and returns a trimmed valid address.
 * This function trims the input address and validates it, returning the trimmed value if valid.
 * @param address The address to validate and trim
 * @returns The trimmed address if valid, null otherwise
 * @remarks
 * This function is the preferred way to get a validated, trimmed address for use in your application.
 */
export const getValidAddress = (address: Address | null | undefined): string | null => {
  return _validateAndTrimAddress(address);
};

/**
 * Checks if an address is in the blocked list and should not emit events.
 * Blocked addresses include the zero address and dead address which are not normal user addresses.
 * @param address The address to check
 * @returns true if the address is blocked, false otherwise
 */
export const isBlockedAddress = (address: Address | null | undefined): boolean => {
  if (!address) return false;
  
  const validAddress = getValidAddress(address);
  if (!validAddress) return false;
  
  // Normalize to checksum format for comparison
  const checksumAddress = toChecksumAddress(validAddress);
  
  return BLOCKED_ADDRESSES.some(blockedAddr => 
    toChecksumAddress(blockedAddr) === checksumAddress
  );
};

export const toChecksumAddress = (address: Address): string => {
  if (!isAddress(address, false)) {
    throw new Error("Invalid address " + address);
  }

  const lowerCaseAddress = address.toLowerCase().replace(/^0x/i, "");

  const hash = uint8ArrayToHexString(
    keccak256(ensureIfUint8Array(utf8ToBytes(lowerCaseAddress)))
  );

  if (
    isNullish(hash) ||
    hash ===
      "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
  )
    return ""; // // EIP-1052 if hash is equal to c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470, keccak was given empty data

  let checksumAddress = "0x";

  const addressHash = hash.replace(/^0x/i, "");

  for (let i = 0; i < lowerCaseAddress.length; i += 1) {
    // If ith character is 8 to f then make it uppercase
    if (parseInt(addressHash[i], 16) > 7) {
      checksumAddress += lowerCaseAddress[i].toUpperCase();
    } else {
      checksumAddress += lowerCaseAddress[i];
    }
  }

  return checksumAddress;
};

/**
 * Validates an EVM address and returns it in checksummed format.
 * @param address The address to validate
 * @returns The checksummed address or undefined if invalid
 */
export const validateAndChecksumAddress = (address: string): Address | undefined => {
  const validAddress = getValidAddress(address);
  return validAddress ? toChecksumAddress(validAddress) : undefined;
};

/**
 * Validates an address for both EVM and Solana chains.
 * For EVM addresses, returns checksummed format.
 * For Solana addresses, returns the Base58 address as-is.
 * @param address The address to validate
 * @param chainId Optional chain ID to help determine address type
 * @returns The validated address or undefined if invalid
 */
export const validateAddress = (
  address: string,
  chainId?: number
): Address | undefined => {
  // If chain ID is in Solana range, validate as Solana address
  const solanaChainIds = Object.values(SOLANA_CHAIN_IDS);
  if (chainId !== undefined && chainId !== null && solanaChainIds.includes(chainId)) {
    return getValidSolanaAddress(address) || undefined;
  }

  // Default to EVM address validation first
  const validEvmAddress = validateAndChecksumAddress(address);
  if (validEvmAddress) {
    return validEvmAddress;
  }

  // Fall back to Solana format when EVM validation fails
  if (isSolanaAddress(address)) {
    return getValidSolanaAddress(address) || undefined;
  }

  return undefined;
};
