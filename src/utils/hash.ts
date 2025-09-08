/**
 * Hash utilities using ethereum-cryptography for secure, deterministic hashing
 */

import { sha256 } from 'ethereum-cryptography/sha256';
import { utf8ToBytes, bytesToHex } from 'ethereum-cryptography/utils';

/**
 * Generate a secure hash of a string using SHA-256 for creating short, consistent identifiers
 * @param str - The string to hash
 * @returns Short hash string (first 8 characters of SHA-256 hex)
 */
export function secureHash(str: string): string {
  const bytes = utf8ToBytes(str);
  const hashBytes = sha256(bytes);
  const hashHex = bytesToHex(hashBytes);
  // Return first 8 characters for reasonable cookie name length
  return hashHex.slice(0, 8);
}
