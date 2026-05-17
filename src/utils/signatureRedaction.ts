/**
 * Signature-event redaction.
 *
 * A wallet signature is a bearer credential: shipping the raw signature
 * (and the exact signed payload) to the analytics backend makes it
 * replayable by anyone who can read that data — critical for `permit` /
 * Permit2 / SIWE / off-chain order signatures. Analytics only needs to
 * know that a signature happened, on what chain, and (optionally) a
 * stable non-replayable correlation token. It must never receive the
 * raw signature or the full EIP-712 struct.
 */
import { secureHash } from "./hash";

/**
 * Raw ECDSA/contract signature shape: `0x` + a long hex blob.
 * - 65-byte ECDSA = 130 hex, EIP-2098 compact = 128 hex, ERC-1271 /
 *   aggregated signatures are longer — so `{128,}` catches them all.
 * A redacted token from `secureHash` is short hex with no `0x`, so it
 * never matches this.
 */
const RAW_SIGNATURE_RE = /^0x[0-9a-fA-F]{128,}$/;

export function looksLikeRawSignature(value: unknown): value is string {
  return typeof value === "string" && RAW_SIGNATURE_RE.test(value);
}

/**
 * Turn a (possibly raw) signature value into a safe, stable, one-way
 * correlation token. Raw signatures are SHA-256'd; anything that is
 * already short/non-signature-shaped is passed through unchanged.
 */
export function redactSignatureHash(
  value: string | undefined
): string | undefined {
  if (value === undefined) return undefined;
  return looksLikeRawSignature(value) ? secureHash(value) : value;
}

type DomainLike = { name?: unknown; chainId?: unknown };
type TypedDataLike = { primaryType?: unknown; domain?: DomainLike };

/**
 * Reduce an EIP-712 typed-data payload to non-sensitive metadata only:
 * `primaryType` and `domain.name` / `domain.chainId`. Never serializes
 * `message` / `types` (the actual signed terms — amounts, spender,
 * deadline, nonce). Accepts either the typed-data object or its JSON
 * string form. Returns a compact JSON string (the event schema expects
 * `message: string`), or `""` if nothing safe can be extracted.
 */
export function redactTypedDataMessage(input: unknown): string {
  let td: TypedDataLike | undefined;

  if (typeof input === "string") {
    try {
      td = JSON.parse(input) as TypedDataLike;
    } catch {
      return "";
    }
  } else if (input && typeof input === "object") {
    td = input as TypedDataLike;
  }

  if (!td || typeof td !== "object") return "";

  const safe: { primaryType?: string; domain?: { name?: string; chainId?: number | string } } = {};

  if (typeof td.primaryType === "string") {
    safe.primaryType = td.primaryType;
  }

  const domain = td.domain;
  if (domain && typeof domain === "object") {
    const d: { name?: string; chainId?: number | string } = {};
    if (typeof domain.name === "string") d.name = domain.name;
    if (typeof domain.chainId === "number" || typeof domain.chainId === "string") {
      d.chainId = domain.chainId;
    }
    if (Object.keys(d).length > 0) safe.domain = d;
  }

  return Object.keys(safe).length > 0 ? JSON.stringify(safe) : "";
}
