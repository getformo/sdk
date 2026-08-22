import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import { JSDOM } from "jsdom";
import { TrackingPolicy } from "../../src/tracking/TrackingPolicy";
import * as timezoneModule from "../../src/utils/timezone";
import { ChainID, Options } from "../../src/types";

/**
 * The tracking rules, exercised without an SDK instance.
 *
 * Before the split these could only be reached through `FormoAnalytics`, so
 * every case needed a constructed SDK, a jsdom, storage and a provider. The
 * rules themselves are pure given options, consent and a chain.
 */
describe("TrackingPolicy", () => {
  let jsdom: JSDOM;
  let optedOut = false;
  let chainId: ChainID | undefined;

  const policy = (options: Partial<Options> = {}) =>
    new TrackingPolicy(options as Options, {
      hasOptedOut: () => optedOut,
      currentChainId: () => chainId,
    });

  beforeEach(() => {
    optedOut = false;
    chainId = undefined;
    jsdom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
      url: "https://app.example.com/dashboard",
    });
    for (const k of ["window", "document", "location"] as const) {
      Object.defineProperty(global, k, {
        value: k === "window" ? jsdom.window : (jsdom.window as any)[k],
        writable: true,
        configurable: true,
      });
    }
  });

  afterEach(() => {
    sinon.restore();
    for (const k of ["window", "document", "location"]) delete (global as any)[k];
    jsdom?.window.close();
  });

  /** The visitor's resolved timezone is environment-dependent, so pin it. */
  const inTimezone = (tz: string | undefined) =>
    sinon.stub(timezoneModule, "getTimezone").returns(tz as string);

  describe("shouldTrack", () => {
    it("refuses everything once the visitor has opted out", () => {
      optedOut = true;
      expect(policy({ tracking: true }).shouldTrack()).to.be.false;
    });

    it("takes an explicit boolean as the whole answer", () => {
      expect(policy({ tracking: true }).shouldTrack()).to.be.true;
      expect(policy({ tracking: false }).shouldTrack()).to.be.false;
    });

    it("refuses an excluded host and an excluded path", () => {
      expect(
        policy({ tracking: { excludeHosts: ["app.example.com"] } }).shouldTrack()
      ).to.be.false;
      expect(
        policy({ tracking: { excludePaths: ["/dashboard"] } }).shouldTrack()
      ).to.be.false;
    });

    it("allows a host or path that does not match exactly", () => {
      expect(
        policy({ tracking: { excludeHosts: ["example.com"] } }).shouldTrack()
      ).to.be.true;
      expect(
        policy({ tracking: { excludePaths: ["/dashboard/settings"] } }).shouldTrack()
      ).to.be.true;
    });

    it("refuses an excluded chain named by the event itself", () => {
      const p = policy({ tracking: { excludeChains: [137] } });
      chainId = 1;
      expect(p.shouldTrack({ chainId: 137 }), "the event's own chain wins").to.be.false;
      expect(p.shouldTrack({ chainId: 1 })).to.be.true;
    });

    it("falls back to the central chain when the event names none", () => {
      const p = policy({ tracking: { excludeChains: [137] } });
      chainId = 137;
      expect(p.shouldTrack()).to.be.false;
      chainId = 1;
      expect(p.shouldTrack()).to.be.true;
    });

    it("fails closed on an unresolvable chain while exclusions are configured", () => {
      // 0 is the explicit "we asked the wallet and could not tell" marker. It
      // is in no exclusion list, so allowing it would let through exactly the
      // events an operator excluded.
      expect(
        policy({ tracking: { excludeChains: [137] } }).shouldTrack({ chainId: 0 })
      ).to.be.false;
    });

    it("allows an unresolvable chain when no chain exclusions are configured", () => {
      expect(policy({ tracking: {} }).shouldTrack({ chainId: 0 })).to.be.true;
    });

    it("allows an absent chain, which is a legitimate transient", () => {
      // `undefined` means no chain state yet, not "we could not tell".
      // Refusing it would drop real events during wallet reconciliation.
      chainId = undefined;
      expect(policy({ tracking: { excludeChains: [137] } }).shouldTrack()).to.be.true;
    });
  });

  describe("suppression and persistence", () => {
    it("treats an opt-out as visitor-level", () => {
      optedOut = true;
      expect(policy({}).isTrackingSuppressed()).to.be.true;
      expect(policy({}).isPersistedIdentityPurgeRequired()).to.be.true;
    });

    it("treats an excluded timezone as visitor-level", () => {
      inTimezone("Europe/London");
      const p = policy({ tracking: { excludeTimezones: ["Europe/London"] } });
      expect(p.isTrackingSuppressed()).to.be.true;
      expect(
        p.isPersistedIdentityPurgeRequired(),
        "stable for the session, so a stale cookie is purged rather than kept"
      ).to.be.true;
      expect(p.shouldTrack()).to.be.false;
    });

    it("matches the excluded timezone case-insensitively", () => {
      inTimezone("Europe/London");
      expect(
        policy({ tracking: { excludeTimezones: ["europe/LONDON"] } }).isTrackingSuppressed()
      ).to.be.true;
    });

    it("allows a timezone that does not match", () => {
      inTimezone("America/New_York");
      const p = policy({ tracking: { excludeTimezones: ["Europe/London"] } });
      expect(p.isTrackingSuppressed()).to.be.false;
      expect(p.shouldTrack()).to.be.true;
    });

    it("allows tracking when the timezone cannot be resolved", () => {
      // Best-effort by design: an unreadable timezone must not silently
      // suppress a visitor who was never excluded.
      inTimezone(undefined);
      expect(
        policy({ tracking: { excludeTimezones: ["Europe/London"] } }).isTrackingSuppressed()
      ).to.be.false;
    });

    it("treats host and path as page-level, so identity is kept but not written", () => {
      const p = policy({ tracking: { excludeHosts: ["app.example.com"] } });
      expect(p.isTrackingSuppressed(), "no events while here").to.be.true;
      expect(
        p.isPersistedIdentityPurgeRequired(),
        "but a cookie written on an allowed page must survive this route"
      ).to.be.false;
      expect(p.isPageExcluded()).to.be.true;
    });

    it("reports no page exclusion when nothing matches", () => {
      expect(policy({ tracking: { excludeHosts: ["other.example.com"] } }).isPageExcluded())
        .to.be.false;
    });
  });

  describe("isChainExcluded", () => {
    it("is false when no chain exclusions are configured", () => {
      expect(policy({ tracking: {} }).isChainExcluded({ chainId: 137 })).to.be.false;
      expect(policy({ tracking: true }).isChainExcluded({ chainId: 137 })).to.be.false;
    });

    it("applies the same fail-closed rule as shouldTrack", () => {
      const p = policy({ tracking: { excludeChains: [137] } });
      expect(p.isChainExcluded({ chainId: 0 })).to.be.true;
      expect(p.isChainExcluded({ chainId: 137 })).to.be.true;
      expect(p.isChainExcluded({ chainId: 1 })).to.be.false;
      expect(p.isChainExcluded()).to.be.false;
    });
  });

  describe("isAutocaptureEnabled", () => {
    it("defaults to enabled when unconfigured", () => {
      expect(policy({}).isAutocaptureEnabled("connect")).to.be.true;
    });

    it("honours a boolean for every kind", () => {
      expect(policy({ autocapture: false }).isAutocaptureEnabled("signature")).to.be.false;
      expect(policy({ autocapture: true }).isAutocaptureEnabled("signature")).to.be.true;
    });

    it("disables only the kinds explicitly set to false", () => {
      const p = policy({ autocapture: { disconnect: false } });
      expect(p.isAutocaptureEnabled("disconnect")).to.be.false;
      expect(p.isAutocaptureEnabled("connect"), "unlisted kinds stay on").to.be.true;
    });
  });
});
