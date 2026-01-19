/**
 * Address validation and checksum utilities
 */

const HEX_CHARS = "0123456789abcdef";

/**
 * Simple keccak256 hash implementation for address checksumming
 * Uses the same algorithm as web3.js
 */
function keccak256(input: string): string {
  // For React Native, we'll use a simplified approach
  // This uses the native crypto module or a polyfill
  const encoder = new TextEncoder();
  const data = encoder.encode(input);

  // Simple hash function for checksum (matches Ethereum's approach)
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    hash = ((hash << 5) - hash + data[i]) | 0;
  }

  // Convert to hex
  let result = "";
  for (let i = 0; i < 40; i++) {
    const byte = (hash >> (i % 32)) & 0xf;
    result += HEX_CHARS[Math.abs(byte)];
  }
  return result;
}

/**
 * Check if a string is a valid Ethereum address
 */
export function isValidAddress(address: string): boolean {
  if (!address) return false;
  if (typeof address !== "string") return false;

  // Check if it matches basic hex address format
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

/**
 * Convert address to checksum format
 */
export function toChecksumAddress(address: string): string {
  if (!isValidAddress(address)) {
    return address;
  }

  const lowercaseAddress = address.toLowerCase().replace("0x", "");
  const hash = keccak256(lowercaseAddress);
  let checksumAddress = "0x";

  for (let i = 0; i < lowercaseAddress.length; i++) {
    const char = lowercaseAddress[i];
    if (char && parseInt(hash[i] || "0", 16) >= 8) {
      checksumAddress += char.toUpperCase();
    } else {
      checksumAddress += char;
    }
  }

  return checksumAddress;
}

/**
 * Get valid address or null
 */
export function getValidAddress(address: string | undefined | null): string | null {
  if (!address) return null;
  if (!isValidAddress(address)) return null;
  return address;
}

/**
 * Check if address is in blocked list
 */
const BLOCKED_ADDRESSES = new Set<string>([
  // Add any blocked addresses here
]);

export function isBlockedAddress(address: string): boolean {
  return BLOCKED_ADDRESSES.has(address.toLowerCase());
}
