/**
 * Signature-event minimization.
 *
 * A wallet signature is a bearer credential: shipping the raw signature
 * (and the exact signed payload) to the analytics backend makes it
 * replayable by anyone who can read that data — critical for `permit` /
 * Permit2 / SIWE / off-chain order signatures. The produced signature is
 * therefore never captured at all (C1). For EIP-712, analytics receives
 * only non-sensitive `primaryType` + domain metadata, never the signed
 * struct.
 */

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
