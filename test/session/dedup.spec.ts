import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { JSDOM } from "jsdom";
import { FormoAnalyticsSession } from "../../src/session";
import { initStorageManager } from "../../src/storage";

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

  it("stays backward compatible: omitting userId matches legacy keys", () => {
    const session = new FormoAnalyticsSession();

    // Legacy call path (address + rdns, no userId) is unchanged.
    session.markWalletIdentified(ADDRESS, RDNS);
    expect(session.isWalletIdentified(ADDRESS, RDNS)).to.equal(true);
    // address-only fallback (no rdns, no userId) is also unchanged.
    session.markWalletIdentified(ADDRESS, "");
    expect(session.isWalletIdentified(ADDRESS, "")).to.equal(true);
  });
});
