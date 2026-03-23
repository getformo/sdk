import type { UUID } from "crypto";
import { sha256 } from 'ethereum-cryptography/sha256';
import { utf8ToBytes, bytesToHex } from 'ethereum-cryptography/utils';

export function hash(input: string): string {
  const bytes = utf8ToBytes(input);
  const hashBytes = sha256(bytes);
  return bytesToHex(hashBytes);
}

export function generateNativeUUID(): UUID {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback using crypto.getRandomValues (available in insecure contexts)
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as UUID;
}
