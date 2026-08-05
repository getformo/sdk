import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { JSDOM } from "jsdom";
import {
  FormoAnalyticsSession,
  SESSION_WALLET_IDENTIFIED_KEY,
} from "../../src/session";
import { cookie, initStorageManager } from "../../src/storage";

/**
 * Session identify deduplication with a user ID folded into the key.
 *
 * Verifies that attaching a user ID (e.g. a Privy DID) to an already-identified
 * wallet is treated as a new identity and re-emits, while repeated identifies
 * with the same (address, rdns, userId) are still deduped.
 */
describe("Session identify dedup with userId", () => {
  let jsdom: JSDOM;

  const ADDRESS = "0x1111111111111111111111111111111111111111";
  const RDNS = "io.metamask";
  const DID = "did:privy:abc123";

  beforeEach(() => {
    jsdom = new JSDOM("<!DOCTYPE html><html><head></head><body></body></html>", {
      url: "https://example.com",
    });
    Object.defineProperty(global, "window", {
      value: jsdom.window, writable: true, configurable: true,
    });
    Object.defineProperty(global, "document", {
      value: jsdom.window.document, writable: true, configurable: true,
    });
    Object.defineProperty(global, "navigator", {
      value: jsdom.window.navigator, writable: true, configurable: true,
    });
    initStorageManager("test-write-key");
  });

  afterEach(() => {
    delete (global as any).window;
    delete (global as any).document;
    delete (global as any).navigator;
  });

  it("re-emits when a userId is attached to an already-identified wallet", () => {
    const session = new FormoAnalyticsSession();

    // First identify: anonymous (no userId).
    expect(session.isWalletIdentified(ADDRESS, RDNS)).to.equal(false);
    session.markWalletIdentified(ADDRESS, RDNS);
    expect(session.isWalletIdentified(ADDRESS, RDNS)).to.equal(true);

    // Same wallet, now with a Privy DID: must NOT be considered already
    // identified, so a fresh identify event is emitted.
    expect(session.isWalletIdentified(ADDRESS, RDNS, DID)).to.equal(false);
    session.markWalletIdentified(ADDRESS, RDNS, DID);
    expect(session.isWalletIdentified(ADDRESS, RDNS, DID)).to.equal(true);
  });

  it("dedups repeated identifies with the same address + userId", () => {
    const session = new FormoAnalyticsSession();

    expect(session.isWalletIdentified(ADDRESS, "", DID)).to.equal(false);
    session.markWalletIdentified(ADDRESS, "", DID);
    // A second identify with the same userId is a duplicate.
    expect(session.isWalletIdentified(ADDRESS, "", DID)).to.equal(true);
  });

  it("treats different userIds on the same wallet as distinct identities", () => {
    const session = new FormoAnalyticsSession();
    const otherDid = "did:privy:xyz789";

    session.markWalletIdentified(ADDRESS, "", DID);
    expect(session.isWalletIdentified(ADDRESS, "", DID)).to.equal(true);
    // Switching to a different user on the same wallet re-emits.
    expect(session.isWalletIdentified(ADDRESS, "", otherDid)).to.equal(false);
  });

  it("handles userIds containing a comma (the cookie delimiter) without breaking dedup", () => {
    const session = new FormoAnalyticsSession();
    // An external userId that contains the comma used to join cookie entries.
    const commaUser = "external,user,42";

    expect(session.isWalletIdentified(ADDRESS, "", commaUser)).to.equal(false);
    session.markWalletIdentified(ADDRESS, "", commaUser);
    // Encoded before storage, so the raw comma can't corrupt the key: the same
    // (wallet, user) is now recognized as already identified rather than
    // re-emitting on every call.
    expect(session.isWalletIdentified(ADDRESS, "", commaUser)).to.equal(true);
  });

  it("retains every identity for a many-wallet user (size-bounded, not a 20-entry cap)", () => {
    const session = new FormoAnalyticsSession();
    const did = "did:privy:manywallets";
    const addrs = Array.from(
      { length: 40 },
      (_, i) => "0x" + (i + 1).toString(16).padStart(40, "0")
    );

    for (const a of addrs) session.markWalletIdentified(a, "", did);

    // All 40 remain recognized - well past the old fixed 20-entry limit, which
    // would have evicted the first 20 and re-emitted them on a later sync.
    for (const a of addrs) {
      expect(session.isWalletIdentified(a, "", did)).to.equal(true);
    }
  });

  it("does not collide a userId with a provider RDNS of the same value", () => {
    const session = new FormoAnalyticsSession();
    // Anonymous identify with rdns = "io.metamask".
    session.markWalletIdentified(ADDRESS, "io.metamask");
    expect(session.isWalletIdentified(ADDRESS, "io.metamask")).to.equal(true);
    // A later identify whose userId equals that RDNS string is a distinct tuple
    // (address + empty rdns + userId), so it must NOT be considered already
    // identified - its identity-link event still emits.
    expect(session.isWalletIdentified(ADDRESS, "", "io.metamask")).to.equal(false);
  });

  it("stays backward compatible: omitting userId matches legacy keys", () => {
    const session = new FormoAnalyticsSession();

    // Legacy call path (address + rdns, no userId) is unchanged.
    session.markWalletIdentified(ADDRESS, RDNS);
    expect(session.isWalletIdentified(ADDRESS, RDNS)).to.equal(true);
    // address-only fallback (no rdns, no userId) is also unchanged.
    session.markWalletIdentified(ADDRESS, "");
    expect(session.isWalletIdentified(ADDRESS, "")).to.equal(true);
  });

  describe("properties fingerprint in the dedup key", () => {
    it("re-emits when the properties change for the same wallet + userId", () => {
      const session = new FormoAnalyticsSession();
      const before = { privyDid: DID, email: "a@b.com" };
      // The motivating case: the user links a Google account. Same wallet,
      // same DID - only the properties changed.
      const after = { privyDid: DID, email: "a@b.com", google: "a@b.com" };

      session.markWalletIdentified(ADDRESS, RDNS, DID, before);
      expect(session.isWalletIdentified(ADDRESS, RDNS, DID, before)).to.equal(
        true
      );

      expect(session.isWalletIdentified(ADDRESS, RDNS, DID, after)).to.equal(
        false
      );
    });

    it("dedups a repeat with identical properties", () => {
      const session = new FormoAnalyticsSession();
      const properties = { privyDid: DID, email: "a@b.com", is_embedded: false };

      session.markWalletIdentified(ADDRESS, RDNS, DID, properties);

      // A re-render passing an equal (but not identical) object must not
      // re-emit, or every React render would produce an identify event.
      expect(
        session.isWalletIdentified(ADDRESS, RDNS, DID, {
          privyDid: DID,
          email: "a@b.com",
          is_embedded: false,
        })
      ).to.equal(true);
    });

    it("is insensitive to property key order", () => {
      const session = new FormoAnalyticsSession();

      session.markWalletIdentified(ADDRESS, RDNS, DID, {
        email: "a@b.com",
        privyDid: DID,
      });
      expect(
        session.isWalletIdentified(ADDRESS, RDNS, DID, {
          privyDid: DID,
          email: "a@b.com",
        })
      ).to.equal(true);
    });

    it("distinguishes nested and array property changes", () => {
      const session = new FormoAnalyticsSession();

      session.markWalletIdentified(ADDRESS, RDNS, DID, {
        meta: { plan: "free", tags: ["a", "b"] },
      });
      expect(
        session.isWalletIdentified(ADDRESS, RDNS, DID, {
          meta: { plan: "pro", tags: ["a", "b"] },
        })
      ).to.equal(false);
      // Array order is meaningful, unlike object key order.
      expect(
        session.isWalletIdentified(ADDRESS, RDNS, DID, {
          meta: { plan: "free", tags: ["b", "a"] },
        })
      ).to.equal(false);
      expect(
        session.isWalletIdentified(ADDRESS, RDNS, DID, {
          meta: { plan: "free", tags: ["a", "b"] },
        })
      ).to.equal(true);
    });

    it("treats empty properties as no properties (legacy key shape)", () => {
      const session = new FormoAnalyticsSession();

      // An identify with no properties must keep matching a key stored by the
      // pre-hash SDK, so upgrading doesn't re-emit every plain identify.
      session.markWalletIdentified(ADDRESS, RDNS, DID);
      expect(session.isWalletIdentified(ADDRESS, RDNS, DID, {})).to.equal(true);
      expect(
        session.isWalletIdentified(ADDRESS, RDNS, DID, undefined)
      ).to.equal(true);
    });

    it("never throws on values JSON.stringify rejects", () => {
      const session = new FormoAnalyticsSession();

      // A web3 app can easily pass a BigInt balance or an object with a back
      // reference. Hashing runs AFTER identify() has updated the active
      // address/user, so a throw here would leave mutated identity state and
      // emit nothing.
      const circular: Record<string, unknown> = { name: "wallet" };
      circular.self = circular;

      // Built at runtime, not as a `10n` literal: this project targets ES5,
      // where BigInt literals aren't available to the compiler.
      const bigIntValue = (global as any).BigInt(10);

      const awkward = {
        balance: bigIntValue,
        circular,
        fn: () => undefined,
        sym: Symbol("s"),
        invalidDate: new Date("nonsense"),
        nan: NaN,
        infinite: Infinity,
        set: new Set([1, 2]),
        map: new Map([["k", "v"]]),
      };

      expect(() =>
        session.markWalletIdentified(ADDRESS, RDNS, DID, awkward)
      ).to.not.throw();
      expect(session.isWalletIdentified(ADDRESS, RDNS, DID, awkward)).to.equal(
        true
      );
    });

    it("distinguishes a BigInt change and a repeated object reference", () => {
      const session = new FormoAnalyticsSession();

      const big = (global as any).BigInt;
      session.markWalletIdentified(ADDRESS, RDNS, DID, { balance: big(10) });
      expect(
        session.isWalletIdentified(ADDRESS, RDNS, DID, { balance: big(11) })
      ).to.equal(false);

      // The same object used twice in one payload is not a cycle, so both
      // occurrences must serialize identically rather than one becoming
      // "circular".
      const shared = { plan: "pro" };
      session.markWalletIdentified(ADDRESS, RDNS, DID, {
        a: shared,
        b: shared,
      });
      expect(
        session.isWalletIdentified(ADDRESS, RDNS, DID, {
          a: { plan: "pro" },
          b: { plan: "pro" },
        })
      ).to.equal(true);
    });

    it("re-emits when a profile reverts to an earlier state", () => {
      const session = new FormoAnalyticsSession();
      const withoutGoogle = { privyDid: DID, email: "a@b.com" };
      const withGoogle = { privyDid: DID, email: "a@b.com", google: "a@b.com" };

      // Link Google, then unlink it. Dedup means "same as this wallet's LAST
      // identify", not "seen at any point", so the revert must re-emit -
      // otherwise unlinking would silently produce no event.
      session.markWalletIdentified(ADDRESS, RDNS, DID, withoutGoogle);
      session.markWalletIdentified(ADDRESS, RDNS, DID, withGoogle);

      expect(
        session.isWalletIdentified(ADDRESS, RDNS, DID, withoutGoogle)
      ).to.equal(false);
      // ...and the current state still dedupes.
      expect(
        session.isWalletIdentified(ADDRESS, RDNS, DID, withGoogle)
      ).to.equal(true);
    });

    it("keeps one entry per wallet-user instead of one per profile state", () => {
      const session = new FormoAnalyticsSession();

      // Five profile changes must not leave five keys behind, or a many-wallet
      // user would push the cookie into size-based eviction.
      for (let i = 0; i < 5; i++) {
        session.markWalletIdentified(ADDRESS, RDNS, DID, { step: i });
      }

      const stored = cookie().get(SESSION_WALLET_IDENTIFIED_KEY) ?? "";
      const keys = stored.split(",").filter(Boolean);

      expect(keys).to.have.length(1);
      expect(session.isWalletIdentified(ADDRESS, RDNS, DID, { step: 4 })).to.equal(
        true
      );
      expect(session.isWalletIdentified(ADDRESS, RDNS, DID, { step: 0 })).to.equal(
        false
      );
    });

    it("supersedes only the same wallet-user, not other identities", () => {
      const session = new FormoAnalyticsSession();
      const OTHER_DID = "did:privy:other";

      session.markWalletIdentified(ADDRESS, RDNS, DID, { v: 1 });
      session.markWalletIdentified(ADDRESS, RDNS, OTHER_DID, { v: 1 });
      // A legacy anonymous key for the same wallet must also survive.
      session.markWalletIdentified(ADDRESS, RDNS);

      session.markWalletIdentified(ADDRESS, RDNS, DID, { v: 2 });

      expect(session.isWalletIdentified(ADDRESS, RDNS, DID, { v: 2 })).to.equal(true);
      expect(
        session.isWalletIdentified(ADDRESS, RDNS, OTHER_DID, { v: 1 })
      ).to.equal(true);
      expect(session.isWalletIdentified(ADDRESS, RDNS)).to.equal(true);
    });

    it("honors toJSON() so wire-distinct values are distinct keys", () => {
      const session = new FormoAnalyticsSession();

      // URL has no enumerable own keys - without honoring toJSON() both of
      // these canonicalize to "{}" and the changed URL is falsely deduped.
      session.markWalletIdentified(ADDRESS, RDNS, DID, {
        endpoint: new URL("https://a.example/"),
      });
      expect(
        session.isWalletIdentified(ADDRESS, RDNS, DID, {
          endpoint: new URL("https://b.example/"),
        })
      ).to.equal(false);
      expect(
        session.isWalletIdentified(ADDRESS, RDNS, DID, {
          endpoint: new URL("https://a.example/"),
        })
      ).to.equal(true);
    });

    it("does not throw when reading properties throws", () => {
      const session = new FormoAnalyticsSession();

      // A Proxy whose ownKeys trap throws escapes a naive Object.keys() call
      // made outside the fingerprint guard.
      const hostile = new Proxy(
        {},
        {
          ownKeys() {
            throw new Error("hostile ownKeys");
          },
        }
      ) as Record<string, unknown>;

      expect(() =>
        session.markWalletIdentified(ADDRESS, RDNS, DID, hostile)
      ).to.not.throw();
      expect(() =>
        session.isWalletIdentified(ADDRESS, RDNS, DID, hostile)
      ).to.not.throw();
    });

    it("dedupes payloads that serialize identically on the wire", () => {
      const session = new FormoAnalyticsSession();

      // JSON omits undefined/function/symbol properties, so all of these send
      // the exact same bytes. Fingerprinting them differently would emit a
      // second identify carrying a byte-identical payload.
      session.markWalletIdentified(ADDRESS, RDNS, DID, { a: 1 });
      expect(
        session.isWalletIdentified(ADDRESS, RDNS, DID, {
          a: 1,
          b: undefined,
          c: () => undefined,
          d: Symbol("s"),
        })
      ).to.equal(true);

      // NaN and Infinity are both sent as null.
      session.markWalletIdentified(ADDRESS, RDNS, DID, { n: null });
      expect(
        session.isWalletIdentified(ADDRESS, RDNS, DID, { n: NaN })
      ).to.equal(true);
    });

    it("treats an all-omitted property bag as no properties", () => {
      const session = new FormoAnalyticsSession();

      // Sends `{}`, exactly like passing nothing, so it must keep the legacy
      // key shape rather than minting a distinct hashed key.
      session.markWalletIdentified(ADDRESS, RDNS, DID);
      expect(
        session.isWalletIdentified(ADDRESS, RDNS, DID, { a: undefined })
      ).to.equal(true);
    });

    it("keeps the stored cookie within the browser's size limit", () => {
      const session = new FormoAnalyticsSession();

      // Keys are percent-encoded once when built and again by CookieStorage,
      // so a raw-length budget understates what is written. Overflowing makes
      // the browser reject the write, so nothing persists and every identify
      // re-emits for the rest of the session.
      for (let i = 0; i < 200; i++) {
        session.markWalletIdentified(
          `0x${i.toString(16).padStart(40, "0")}`,
          RDNS,
          // A DID-shaped id, whose colons percent-encode twice.
          `did:privy:cm3np${i}`,
          { privyDid: `did:privy:cm3np${i}`, email: "user@example.com" }
        );
      }

      const stored = cookie().get(SESSION_WALLET_IDENTIFIED_KEY) ?? "";
      expect(encodeURIComponent(stored).length).to.be.at.most(4096 - 512);
      // Eviction must never drop the key it just wrote.
      expect(
        session.isWalletIdentified(
          `0x${(199).toString(16).padStart(40, "0")}`,
          RDNS,
          "did:privy:cm3np199",
          { privyDid: "did:privy:cm3np199", email: "user@example.com" }
        )
      ).to.equal(true);
    });

    it("treats undefined and null property values as different", () => {
      const session = new FormoAnalyticsSession();

      // JSON omits an undefined property but sends null, so collapsing the two
      // would suppress a real value -> null update.
      session.markWalletIdentified(ADDRESS, RDNS, DID, { plan: undefined });
      expect(
        session.isWalletIdentified(ADDRESS, RDNS, DID, { plan: null })
      ).to.equal(false);
    });

    it("keys properties without a userId, without colliding on rdns", () => {
      const session = new FormoAnalyticsSession();
      const properties = { plan: "pro" };

      session.markWalletIdentified(ADDRESS, RDNS, undefined, properties);
      expect(
        session.isWalletIdentified(ADDRESS, RDNS, undefined, properties)
      ).to.equal(true);
      // The legacy 2-component `address:rdns` key must stay distinct from the
      // 4-component keyed-with-properties form.
      expect(session.isWalletIdentified(ADDRESS, RDNS)).to.equal(false);
    });
  });
});
