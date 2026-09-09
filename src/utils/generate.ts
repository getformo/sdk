import type { UUID } from "crypto";
import { sha256 } from 'ethereum-cryptography/sha256';
import { utf8ToBytes, bytesToHex } from 'ethereum-cryptography/utils';

/**
 * JSON with object keys in sorted order at every depth, so two property
 * bags built in a different order serialize the same. Otherwise it follows
 * JSON.stringify: toJSON() is honored, boxed primitives unbox, arrays keep
 * their order and holes become null, undefined values are omitted, and a
 * cycle throws. Returns undefined where JSON.stringify would.
 */
export function stableStringify(value: unknown): string | undefined {
  return JSON.stringify(canonical(value, "", new Set(), false));
}

/** A sorted, cycle-checked clone that JSON.stringify serializes as-is. */
function canonical(value: unknown, key: string, stack: Set<unknown>, fromToJSON: boolean): unknown {
  // Objects, functions and bigints can carry a toJSON hook, as in JSON.stringify.
  const t = typeof value;
  const hookable = value !== null && (t === "object" || t === "function" || t === "bigint");
  if (!hookable) return value;
  // toJSON() runs once per property, as in JSON.stringify: what it returns
  // is serialized as-is, its own hook included, and a hook that returns its
  // own object serializes by its fields. The hook is read once, so an
  // accessor cannot hand back two different values.
  if (!fromToJSON) {
    const hook = (value as { toJSON?: unknown }).toJSON;
    if (typeof hook === "function") {
      return canonical(Reflect.apply(hook, value, [key]), key, stack, true);
    }
  }
  // A bigint without a hook is left to JSON.stringify, which throws on it.
  if (typeof value === "bigint") return value;
  // A function with no hook is omitted, as JSON.stringify omits it.
  if (typeof value === "function") return undefined;
  // Unboxed through the built-in methods, not an override on the instance.
  // Guarded: a runtime without BigInt must not throw here on every object.
  if (typeof BigInt !== "undefined" && value instanceof BigInt) {
    return BigInt.prototype.valueOf.call(value); // JSON.stringify throws on it
  }
  if (value instanceof Number) return Number.prototype.valueOf.call(value);
  if (value instanceof String) return String.prototype.valueOf.call(value);
  if (value instanceof Boolean) return Boolean.prototype.valueOf.call(value);
  if (stack.has(value)) throw new TypeError("Converting circular structure to JSON");
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      const items: unknown[] = [];
      const length = value.length; // read once, as JSON.stringify does
      for (let i = 0; i < length; i++) items.push(canonical(value[i], String(i), stack, false));
      return items;
    }
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = Object.create(null);
    // JSON.stringify omits undefined and symbol values itself.
    for (const k of Object.keys(record).sort()) sorted[k] = canonical(record[k], k, stack, false);
    return sorted;
  } finally {
    stack.delete(value);
  }
}

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
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
    const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as UUID;
  }
  // Last resort: Math.random (not cryptographically secure, but functional)
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  }) as UUID;
}
