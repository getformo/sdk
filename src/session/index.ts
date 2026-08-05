/**
 * Session management for Formo Analytics
 * 
 * Handles tracking of detected wallets and identified wallet-address pairs
 * using cookies to maintain state across page loads within a session.
 */

import { cookie } from "../storage";
import { getIdentityCookieSecurity } from "../storage/cookiePolicy";
import { logger } from "../logger";
import type { IFormoEventProperties } from "../types/events";

/**
 * Serialize a value so that equal values always produce the same string,
 * regardless of object key insertion order.
 *
 * `JSON.stringify` preserves insertion order, so `{a:1,b:2}` and `{b:2,a:1}`
 * would hash differently and re-emit an identify that carries identical
 * properties. Object keys are therefore sorted; arrays keep their order, since
 * order is meaningful there.
 *
 * **This function must never throw.** It runs inside `identify()` *after* the
 * active address/user have been updated, so a throw would leave the SDK with
 * mutated identity state and no emitted event. `JSON.stringify` throws on
 * circular references and on `BigInt` - both realistic here, since a web3 app
 * can easily pass a token balance (`123n`) or a wallet object with a back
 * reference in `properties`. Every such case is therefore handled explicitly
 * and degrades to a stable marker instead of an exception.
 *
 * Totality here is only about *dedup*: it guarantees the fingerprint step can't
 * be what loses an identify. It does **not** make such values sendable - the
 * event queue still serializes with native `JSON.stringify`, so a `BigInt` or
 * circular value in `properties` fails downstream exactly as it does for
 * `track()`. That is a separate, pre-existing SDK-wide limitation.
 *
 * It mirrors `JSON.stringify`'s own value semantics so the fingerprint tracks
 * **what actually goes on the wire**, not what happens to be in the object:
 *
 * - `undefined`, functions, and symbols are *omitted* as object properties and
 *   become `null` as array elements, exactly as JSON does. Two property sets
 *   that serialize identically must fingerprint identically, or dedup emits a
 *   second identify carrying a byte-identical payload.
 * - `null` stays `null`, so a real value → `null` update is never mistaken for
 *   an omitted key.
 * - `NaN`/`Infinity` become `null`, because that is what is sent.
 * - `toJSON()` is honored, so `Date` and `URL` reflect their serialized form
 *   rather than their (often empty) enumerable keys.
 * - `Map`/`Set` have no enumerable own properties and no `toJSON`, so they send
 *   as `{}` - and therefore canonicalize as `{}`.
 *
 * The exceptions are the two things JSON *cannot* represent: `BigInt` and
 * circular references both make `JSON.stringify` throw. They get distinct
 * markers instead, because this function must never throw - it runs inside
 * `identify()` *after* the active address/user have been updated, so a throw
 * would leave the SDK with mutated identity state and no emitted event.
 *
 * Totality here is only about *dedup*: it guarantees the fingerprint step can't
 * be what loses an identify. It does **not** make such values sendable - the
 * event queue still serializes with native `JSON.stringify`, so a `BigInt` or
 * circular value in `properties` fails downstream exactly as it does for
 * `track()`. That is a separate, pre-existing SDK-wide limitation.
 *
 * Returns `undefined` when JSON would omit the value entirely.
 */
function stableStringify(
  value: unknown,
  seen: Set<unknown> = new Set()
): string | undefined {
  // JSON omits these as object properties; array elements are mapped to "null"
  // by the caller below.
  if (value === undefined) return undefined;
  if (typeof value === "function") return undefined;
  if (typeof value === "symbol") return undefined;

  if (value === null) return "null";
  // JSON.stringify throws on BigInt, so it has no wire form to mirror.
  if (typeof value === "bigint") return `bigint:${value.toString()}`;
  if (typeof value === "number") {
    // NaN and Infinity are sent as null.
    return Number.isFinite(value) ? JSON.stringify(value) : "null";
  }
  if (typeof value !== "object") {
    // Remaining primitives: string, boolean.
    return JSON.stringify(value);
  }

  // Cycle guard: a repeated reference within the current path is replaced by a
  // marker rather than recursing forever. JSON.stringify would throw here.
  if (seen.has(value)) return '"[circular]"';
  seen.add(value);
  try {
    // JSON calls toJSON() before inspecting the value, so do it first. This is
    // what makes an invalid Date canonicalize as null (Date.prototype.toJSON
    // returns null rather than throwing) and a URL reflect its href.
    const maybeToJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof maybeToJSON === "function") {
      return stableStringify((maybeToJSON as () => unknown).call(value), seen);
    }
    if (Array.isArray(value)) {
      return `[${value
        .map((item) => stableStringify(item, seen) ?? "null")
        .join(",")}]`;
    }
    // Everything else, Map and Set included, serializes from its enumerable own
    // properties. Keys are sorted so insertion order can't change the result.
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const encoded = stableStringify(record[key], seen);
      if (encoded === undefined) continue; // JSON omits this property
      parts.push(`${JSON.stringify(key)}:${encoded}`);
    }
    return `{${parts.join(",")}}`;
  } finally {
    // Only guard against cycles, not repeated siblings: the same object used
    // twice in one payload must serialize the same both times.
    seen.delete(value);
  }
}

/**
 * Short, stable fingerprint of an identify's properties (two FNV-1a lanes,
 * base36).
 *
 * Folded into the dedup key so that re-identifying a known wallet with *changed*
 * properties re-emits, while an unchanged repeat still dedupes. Kept short
 * because every key is stored in a size-bounded cookie.
 *
 * Two independent lanes (different offset bases, combined into ~64 bits) rather
 * than one: a single 32-bit lane collides readily - `{"x":"xefn1fnkq0"}` and
 * `{"x":"filot3n704"}` both hash to `1mgjpo5` - and a collision here silently
 * suppresses a legitimately changed profile for the rest of the session. At 64
 * bits that is no longer a practical concern, for six more characters per key.
 */
function fingerprintProperties(
  properties?: IFormoEventProperties
): string | undefined {
  if (!properties) return undefined;
  let serialized: string;
  try {
    // Canonicalize first, then decide emptiness from the result. Anything that
    // serializes to `{}` - a literal `{}`, or an object whose every value JSON
    // omits - carries no wire payload, so it keeps the legacy no-hash key shape
    // rather than getting a hash of "{}". Doing this inside the guard matters:
    // reading properties can run user code (a Proxy with a throwing ownKeys
    // trap), and this whole function must be total.
    const canonical = stableStringify(properties);
    if (canonical === undefined || canonical === "{}") return undefined;
    serialized = canonical;
  } catch (error) {
    // stableStringify handles every value type it knows about, but reading a
    // property can still run arbitrary user code (a throwing getter, an exotic
    // Proxy). Identity state has already been updated by the time we get here,
    // so failing closed to a constant is the safe outcome: dedup degrades to
    // the pre-fingerprint behavior (identify once per session for this wallet)
    // instead of the whole identify being swallowed by the catch in identify().
    logger.warn?.("Session: failed to fingerprint identify properties", error);
    return "nohash";
  }
  let lane1 = 0x811c9dc5;
  let lane2 = 0x01000193;
  for (let i = 0; i < serialized.length; i++) {
    const code = serialized.charCodeAt(i);
    lane1 ^= code;
    lane1 = Math.imul(lane1, 0x01000193);
    // A second lane with a different seed and multiplier, fed the position as
    // well as the character, so the two lanes don't move together.
    lane2 ^= code + i;
    lane2 = Math.imul(lane2, 0x85ebca6b);
  }
  return `${(lane1 >>> 0).toString(36)}${(lane2 >>> 0).toString(36)}`;
}

/**
 * Cookie keys for session tracking
 * NOTE: These values must match the original constants in constants/base.ts
 * to maintain backward compatibility with existing user sessions
 */
export const SESSION_WALLET_DETECTED_KEY = "wallet-detected";
export const SESSION_WALLET_IDENTIFIED_KEY = "wallet-identified";

/**
 * Interface for session management operations
 */
export interface IFormoAnalyticsSession {
  /**
   * Check if a wallet has been detected in this session
   * @param rdns The reverse domain name (RDNS) of the wallet provider
   */
  isWalletDetected(rdns: string): boolean;
  
  /**
   * Mark a wallet as detected in this session
   * @param rdns The reverse domain name (RDNS) of the wallet provider
   */
  markWalletDetected(rdns: string): void;
  
  /**
   * Check if a wallet-address pair has been identified in this session
   * @param address The wallet address
   * @param rdns The reverse domain name (RDNS) of the wallet provider
   * @param userId Optional external user ID (e.g. a Privy DID). When provided,
   *   it is folded into the dedup key so attaching a new user ID to an
   *   already-identified wallet re-emits instead of being silently deduped.
   * @param properties Optional identify properties. Fingerprinted into the
   *   dedup key so an identify whose properties have *changed* (e.g. a Privy
   *   user linked a new social account) re-emits, while an unchanged repeat
   *   still dedupes.
   */
  isWalletIdentified(
    address: string,
    rdns: string,
    userId?: string,
    properties?: IFormoEventProperties
  ): boolean;

  /**
   * Mark a wallet-address pair as identified in this session
   * @param address The wallet address
   * @param rdns The reverse domain name (RDNS) of the wallet provider
   * @param userId Optional external user ID (e.g. a Privy DID). See
   *   {@link isWalletIdentified} for how it affects the dedup key.
   * @param properties Optional identify properties. See
   *   {@link isWalletIdentified}.
   */
  markWalletIdentified(
    address: string,
    rdns: string,
    userId?: string,
    properties?: IFormoEventProperties
  ): void;
}

/**
 * Implementation of session management using cookies
 * 
 * Tracks:
 * - Detected wallets (by RDNS) - to prevent duplicate detection events
 * - Identified wallet-address pairs - to prevent duplicate identification events
 *
 * Session data expires at end of day (86400 seconds).
 */
const MAX_SESSION_ENTRIES = 20;

/**
 * Byte budget for the identified-wallet cookie, measured on the value as the
 * browser actually stores it.
 *
 * A Privy user can identify far more than 20 wallets in one session (an 8+
 * wallet user is the motivating case), so a fixed entry count would evict
 * `(wallet, userId)` keys and let a later sync re-emit them. Instead we bound
 * the store by serialized size and evict oldest only when it would overflow the
 * cookie - so every identity that fits is retained.
 *
 * The budget must be applied to the **encoded** length. Key components are
 * already percent-encoded, and `CookieStorage.set()` then encodes the whole
 * joined value again, so `%3A` becomes `%253A` and each `,` separator becomes
 * `%2C`. Measuring the raw string underestimates what is written: 37 realistic
 * DID-bearing keys measure 3500 raw but 3956 encoded, and a non-ASCII external
 * user id inflates far more than that. Overflowing makes the browser reject the
 * write outright, so nothing is persisted and every identify re-emits for the
 * rest of the session - the exact failure the store exists to prevent.
 */
const MAX_COOKIE_BYTES = 4096;
/** Reserve for the cookie name plus path/expires/SameSite/Secure attributes. */
const COOKIE_OVERHEAD_RESERVE = 512;
const MAX_IDENTIFIED_ENCODED_BYTES = MAX_COOKIE_BYTES - COOKIE_OVERHEAD_RESERVE;

/** Length of a cookie value as written, i.e. after CookieStorage encodes it. */
function encodedCookieLength(value: string): number {
  return encodeURIComponent(value).length;
}

export class FormoAnalyticsSession implements IFormoAnalyticsSession {
  /**
   * Generate a unique key for wallet identification tracking.
   *
   * Combines address, RDNS, and (optionally) the external user ID and a
   * fingerprint of the identify's properties, so the key identifies a specific
   * wallet-user-profile combination rather than just an address.
   *
   * Folding the user ID in means the same wallet identified first anonymously
   * and later with a user ID (e.g. after a Privy login attaches a DID) produces
   * two distinct keys, so the second identify is not deduped.
   *
   * Folding the properties hash in means a *changed* profile re-emits. This
   * matters for account linking: a Privy user who links a Google account keeps
   * the same wallets and the same DID, so without the hash every already-seen
   * wallet would dedupe and the new `google` property would never reach Formo
   * until the session expired. An identify repeated with identical properties
   * still dedupes, so this does not turn a re-render into an event.
   *
   * Key shapes, by component count - each is unambiguous, so they cannot
   * collide with one another:
   *
   * | Components | Shape | When |
   * | --- | --- | --- |
   * | 1 | `address` | no rdns, no userId, no properties |
   * | 2 | `address:rdns` | rdns only |
   * | 3 | `address:rdns:userId` | userId, no properties |
   * | 4 | `address:rdns:userId:hash` | properties present |
   *
   * Shapes 1 and 2 are unchanged from before user IDs and property hashes
   * existed, so keys already stored in browsers still match (backward
   * compatible). An identify that carries properties moves to shape 4, so the
   * first identify after an upgrade re-emits once per wallet - a one-off, and
   * the correct outcome, since those properties were never recorded under the
   * new key.
   *
   * @param address The wallet address
   * @param rdns The reverse domain name of the wallet provider
   * @param userId Optional external user ID (e.g. a Privy DID)
   * @param properties Optional identify properties, fingerprinted into the key
   * @returns A unique identification key
   */
  private generateIdentificationKey(
    address: string,
    rdns: string,
    userId?: string,
    properties?: IFormoEventProperties
  ): string {
    return this.buildIdentificationKey(address, rdns, userId, properties).key;
  }

  /**
   * Build the dedup key plus the **identity prefix** it belongs to.
   *
   * The identity prefix is the key with the properties hash stripped -
   * `address:rdns:userId` - i.e. *which wallet-user this is*, independent of
   * *what profile it last had*. `markWalletIdentified` uses it to drop that
   * identity's previous state before storing the new one, which matters twice:
   *
   * - **Reversion.** Keeping every state seen would make dedup mean "have I
   *   ever seen this exact profile", so a profile that goes A → B → A (link
   *   then unlink an account) would find the old A key and emit nothing. Dedup
   *   should mean "is this the same as this wallet's *last* identify", so only
   *   the current state is retained.
   * - **Growth.** Otherwise each profile change adds a key per wallet, and an
   *   8-wallet user linking a few accounts would push the cookie into eviction.
   *   Superseding keeps it at one entry per wallet-user.
   *
   * The prefix is only defined for keys that have a userId and/or a properties
   * hash (3+ components). The legacy 1- and 2-component shapes are the whole
   * identity already, so there is nothing to supersede.
   */
  private buildIdentificationKey(
    address: string,
    rdns: string,
    userId?: string,
    properties?: IFormoEventProperties
  ): { key: string; identityPrefix?: string } {
    // Percent-encode each component before joining. The identified-wallet list
    // is persisted comma-joined in a cookie and later split on commas, so a raw
    // comma in an arbitrary external userId would corrupt the key and defeat
    // dedup (the same identify would re-emit on every call). Encoding also keeps
    // the ":" separator unambiguous. Addresses and RDNS contain no reserved
    // characters, so their encoded form is unchanged - existing stored keys
    // still match (backward compatible).
    // An identify with no properties keeps the pre-hash key shape, so the
    // common `identify({ address })` call is unaffected.
    const propertiesHash = fingerprintProperties(properties);

    const parts = [encodeURIComponent(address)];
    if (userId || propertiesHash) {
      // Once any later slot is set, always emit the intervening slots (even when
      // empty) so the tuple has a fixed shape. Otherwise a userId that happens to
      // equal a provider RDNS (e.g. "io.metamask") would produce the same key as
      // an anonymous `address:rdns` identify and be wrongly deduped. userId and
      // hash keys are new, so this shape has no backward-compat cost.
      parts.push(encodeURIComponent(rdns || ""));
      parts.push(encodeURIComponent(userId || ""));
      const identityPrefix = parts.join(":");
      if (propertiesHash) parts.push(propertiesHash);
      return { key: parts.join(":"), identityPrefix };
    }
    if (rdns) {
      parts.push(encodeURIComponent(rdns));
    }
    return { key: parts.join(":") };
  }

  /**
   * Check if a wallet provider has been detected in this session
   * 
   * @param rdns The reverse domain name of the wallet provider
   * @returns true if the wallet has been detected
   */
  public isWalletDetected(rdns: string): boolean {
    const rdnses = cookie().get(SESSION_WALLET_DETECTED_KEY)?.split(",") || [];
    return rdnses.includes(rdns);
  }

  /**
   * Mark a wallet provider as detected in this session
   * Prevents duplicate detection events from being emitted
   * 
   * @param rdns The reverse domain name of the wallet provider
   */
  public markWalletDetected(rdns: string): void {
    const rdnses = cookie().get(SESSION_WALLET_DETECTED_KEY)?.split(",") || [];
    if (!rdnses.includes(rdns)) {
      rdnses.push(rdns);
      if (rdnses.length > MAX_SESSION_ENTRIES) {
        rdnses.splice(0, rdnses.length - MAX_SESSION_ENTRIES);
      }
      cookie().set(SESSION_WALLET_DETECTED_KEY, rdnses.join(","), {
        // Expires by the end of the day
        expires: new Date(Date.now() + 86400 * 1000).toUTCString(),
        path: "/",
        ...getIdentityCookieSecurity(),
      });
    }
  }

  /**
   * Check if a specific wallet-address combination has been identified
   * 
   * @param address The wallet address
   * @param rdns The reverse domain name of the wallet provider
   * @returns true if this wallet-address pair has been identified
   */
  public isWalletIdentified(
    address: string,
    rdns: string,
    userId?: string,
    properties?: IFormoEventProperties
  ): boolean {
    const identifiedKey = this.generateIdentificationKey(
      address,
      rdns,
      userId,
      properties
    );
    const cookieValue = cookie().get(SESSION_WALLET_IDENTIFIED_KEY);
    const identifiedWallets = cookieValue?.split(",") || [];
    const isIdentified = identifiedWallets.includes(identifiedKey);
    
    logger.debug("Session: Checking wallet identification", {
      identifiedKey,
      isIdentified,
      hasRdns: !!rdns,
    });
    
    return isIdentified;
  }

  /**
   * Mark a wallet-address combination as identified in this session
   * Prevents duplicate identification events from being emitted
   * 
   * @param address The wallet address
   * @param rdns The reverse domain name of the wallet provider
   */
  public markWalletIdentified(
    address: string,
    rdns: string,
    userId?: string,
    properties?: IFormoEventProperties
  ): void {
    const { key: identifiedKey, identityPrefix } = this.buildIdentificationKey(
      address,
      rdns,
      userId,
      properties
    );
    let identifiedWallets: string[] =
      cookie().get(SESSION_WALLET_IDENTIFIED_KEY)?.split(",") || [];
    const alreadyExists = identifiedWallets.includes(identifiedKey);

    if (!alreadyExists) {
      // Supersede this wallet-user's previous profile state rather than
      // accumulating one key per state. Without this, a profile that reverts to
      // an earlier value (link then unlink an account) would match the stale key
      // and emit nothing, and every profile change would grow the cookie.
      if (identityPrefix) {
        identifiedWallets = identifiedWallets.filter(
          (entry) =>
            entry !== identityPrefix &&
            !entry.startsWith(`${identityPrefix}:`)
        );
      }
      identifiedWallets.push(identifiedKey);
      // Bound the stored list by serialized size (not a fixed entry count) so a
      // many-wallet Privy user's identities all persist, evicting oldest only if
      // the value would overflow the cookie.
      //
      // `shift()` drops the oldest from the front while the new key was pushed
      // to the back, and the loop stops at one entry, so the just-added key can
      // never be evicted. A single key is bounded by its components (address +
      // rdns + external user id + a 13-char hash) and cannot on its own approach
      // the budget, so there is no oversized-single-entry case to handle.
      let newValue = identifiedWallets.join(",");
      while (
        identifiedWallets.length > 1 &&
        encodedCookieLength(newValue) > MAX_IDENTIFIED_ENCODED_BYTES
      ) {
        identifiedWallets.shift();
        newValue = identifiedWallets.join(",");
      }
      cookie().set(SESSION_WALLET_IDENTIFIED_KEY, newValue, {
        // Expires by the end of the day
        expires: new Date(Date.now() + 86400 * 1000).toUTCString(),
        path: "/",
        ...getIdentityCookieSecurity(),
      });
      
      logger.debug("Session: Marked wallet as identified", {
        identifiedKey,
        hasRdns: !!rdns,
      });
    } else {
      logger.info("Session: Wallet already marked as identified", {
        identifiedKey,
        existingWallets: identifiedWallets,
        hasRdns: !!rdns,
      });
    }
  }
}

