import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { JSDOM } from "jsdom";
import { EventFactory } from "../../../src/event/EventFactory";
import {
  sanitizeClickId,
  sanitizeRef,
  sanitizeUtm,
  sanitizeTrafficSources,
} from "../../../src/event/sanitize";
import { initStorageManager, session } from "../../../src/storage";
import { SESSION_TRAFFIC_SOURCE_KEY } from "../../../src/constants";

/**
 * Tests for traffic-source value sanitization.
 *
 * Vulnerability scanners crawl customer sites injecting XSS probes into every
 * query parameter; without validation those payloads were captured verbatim
 * as utm_* / click-id / ref values and polluted attribution reporting. The
 * payloads asserted below are real values observed in production events.
 */

// Acunetix DOM-XSS probe — injected into every query param of scanned sites.
const ACUNETIX_PAYLOAD = `javascript:domxssExecutionSink(1,"'\\"><xsstag>()locxss")`;

describe("traffic-source sanitizers", () => {
  describe("sanitizeClickId", () => {
    it("keeps legitimate platform click IDs", () => {
      // Real-shaped values: gclid (base64url), fbclid (with _aem_ segment),
      // twclid, gad_source.
      const legit = [
        "CjwKCAjw6c63BhAiEiwAF0EH1PGgnZ8bZBz-M9EbXCzC1XPeIcbEHKMYXBLmM0Wxrr0y7DEjuMt5RoCP34QAvD_BwE",
        "IwZXh0bgNhZW0CMTEAAR1x_aem_N1o_0GyGQNu376L7Pt6VcA",
        "26cq47zg1e7en9nn2n7dj0y7n1",
        "1",
        "a.b-c_d",
      ];
      for (const v of legit) {
        expect(sanitizeClickId(v)).to.equal(v);
      }
    });

    it("drops the Acunetix DOM-XSS probe", () => {
      expect(sanitizeClickId(ACUNETIX_PAYLOAD)).to.equal("");
    });

    it("drops values with a URL-encoded fragment glued on", () => {
      // Observed: fbclid followed by %23open-positions from a mangled link.
      expect(
        sanitizeClickId("PAQ0xDSwOS0eZleHRuA_aem_x%23open-positions")
      ).to.equal("");
    });

    it("drops values over 255 characters", () => {
      expect(sanitizeClickId("a".repeat(256))).to.equal("");
      expect(sanitizeClickId("a".repeat(255))).to.equal("a".repeat(255));
    });
  });

  describe("sanitizeRef", () => {
    it("keeps legitimate referral codes", () => {
      const legit = ["D7WXN_N4", "ILPYAL", "nb4wtgm", "ref.code-01", "0xAbC123"];
      for (const v of legit) {
        expect(sanitizeRef(v)).to.equal(v);
      }
    });

    it("drops scanner and malformed values observed in production", () => {
      const garbage = [
        "javascript:alert(1)",
        // Referral code with a full URL glued on.
        "D7WXN_N4https://divvy.bet/world-cup-2026?ref=D7WXN_N4",
        // Referral code glued to a path.
        "ILPYAL/contact",
        // Trailing mangled-encoding characters.
        "solanaIDñ",
        "niphermed…",
        "081544cf62b49b3cd68c374ac4689db3⁠�",
        // Trailing punctuation / whitespace.
        "nb4wtgm?",
        "-MCW_JQR -",
        "83a5886c901e030991ad4ec5936a84fa\\",
        // Free text typed into the ref param.
        "PROPR (currently in closed public phase)",
      ];
      for (const v of garbage) {
        expect(sanitizeRef(v), v).to.equal("");
      }
    });

    it("caps length at 64 characters", () => {
      expect(sanitizeRef("a".repeat(64))).to.equal("a".repeat(64));
      expect(sanitizeRef("a".repeat(65))).to.equal("");
    });
  });

  describe("sanitizeUtm", () => {
    it("keeps free-form but benign UTM values", () => {
      const legit = [
        "twitter",
        "summer_sale-2026",
        "spring sale + more",
        "newsletter+june",
        "キャンペーン", // unicode campaign name
        "100%_off",
      ];
      for (const v of legit) {
        expect(sanitizeUtm(v)).to.equal(v);
      }
    });

    it("drops XSS probes observed in production", () => {
      const garbage = [
        ACUNETIX_PAYLOAD,
        "<script>alert(1234)</script>",
        "<img src=x onerror=alert('injected!')>",
        `"><input type="hidden" oncontentvisibilityautostatechange="confirm(/Bypassed/)" style="content-visibility:auto">`,
        `'><marquee onstart="[cookie].find(confirm)"`,
        "/\">'><sVg/onxxx=\"x=y\"oNload=1^(alert)(1)``^1//",
        "#/<script>alert(1234)</script>",
      ];
      for (const v of garbage) {
        expect(sanitizeUtm(v), v).to.equal("");
      }
    });

    it("drops dangerous scheme prefixes case-insensitively", () => {
      expect(sanitizeUtm("JavaScript:alert(1)")).to.equal("");
      expect(sanitizeUtm(" data:text/html;base64,x")).to.equal("");
      expect(sanitizeUtm("vbscript:msgbox(1)")).to.equal("");
      // A scheme-ish word not in a scheme position is fine.
      expect(sanitizeUtm("my-javascript-course")).to.equal(
        "my-javascript-course"
      );
    });

    it("drops control, zero-width, and replacement characters", () => {
      expect(sanitizeUtm("camp\u0000aign")).to.equal("");
      expect(sanitizeUtm("camp\u200baign")).to.equal("");
      expect(sanitizeUtm("campaign\ufffd")).to.equal("");
    });

    it("drops values over 255 characters", () => {
      expect(sanitizeUtm("a".repeat(255))).to.equal("a".repeat(255));
      expect(sanitizeUtm("a".repeat(256))).to.equal("");
    });
  });

  describe("sanitizeTrafficSources", () => {
    it("applies the per-field rules and leaves referrer untouched", () => {
      const result = sanitizeTrafficSources({
        utm_source: "<script>alert(1)</script>",
        utm_campaign: "summer sale",
        twclid: ACUNETIX_PAYLOAD,
        gclid: "CjwKCAjw_legit-id",
        ref: "javascript:alert(1)",
        referrer: "https://t.co/abc?x='quoted'",
      });
      expect(result.utm_source).to.equal("");
      expect(result.utm_campaign).to.equal("summer sale");
      expect(result.twclid).to.equal("");
      expect(result.gclid).to.equal("CjwKCAjw_legit-id");
      expect(result.ref).to.equal("");
      expect(result.referrer).to.equal("https://t.co/abc?x='quoted'");
    });

    it("handles sparse stored objects without adding keys", () => {
      const sparse = { ref: "GOODCODE" };
      const result = sanitizeTrafficSources(sparse);
      expect(result).to.deep.equal({ ref: "GOODCODE" });
    });
  });
});

describe("EventFactory traffic-source sanitization", () => {
  let jsdom: JSDOM;

  beforeEach(() => {
    jsdom = new JSDOM(
      "<!DOCTYPE html><html><head><title>Test Page</title></head><body></body></html>",
      { url: "https://formo.so/" }
    );

    Object.defineProperty(global, "window", {
      value: jsdom.window, writable: true, configurable: true,
    });
    Object.defineProperty(global, "document", {
      value: jsdom.window.document, writable: true, configurable: true,
    });
    Object.defineProperty(global, "location", {
      value: jsdom.window.location, writable: true, configurable: true,
    });
    Object.defineProperty(global, "globalThis", {
      value: jsdom.window, writable: true, configurable: true,
    });
    Object.defineProperty(global, "navigator", {
      value: jsdom.window.navigator, writable: true, configurable: true,
    });
    Object.defineProperty(global, "screen", {
      value: jsdom.window.screen, writable: true, configurable: true,
    });
    Object.defineProperty(global, "devicePixelRatio", {
      value: 1, writable: true, configurable: true,
    });
    Object.defineProperty(global, "innerWidth", {
      value: 1920, writable: true, configurable: true,
    });
    Object.defineProperty(global, "innerHeight", {
      value: 1080, writable: true, configurable: true,
    });
    Object.defineProperty(global, "Intl", {
      value: {
        DateTimeFormat: () => ({
          resolvedOptions: () => ({ timeZone: "America/New_York" }),
        }),
      },
      writable: true, configurable: true,
    });
    Object.defineProperty(global, "localStorage", {
      value: jsdom.window.localStorage, writable: true, configurable: true,
    });
    Object.defineProperty(global, "sessionStorage", {
      value: jsdom.window.sessionStorage, writable: true, configurable: true,
    });
    Object.defineProperty(global, "crypto", {
      value: { randomUUID: () => "12345678-1234-1234-1234-123456789abc" },
      writable: true, configurable: true,
    });

    initStorageManager("test-write-key");

    // Clear sticky traffic-source state so each test starts clean.
    try {
      session().remove(SESSION_TRAFFIC_SOURCE_KEY);
    } catch {}
  });

  afterEach(() => {
    delete (global as any).window;
    delete (global as any).document;
    delete (global as any).location;
    delete (global as any).globalThis;
    delete (global as any).navigator;
    delete (global as any).screen;
    delete (global as any).devicePixelRatio;
    delete (global as any).innerWidth;
    delete (global as any).innerHeight;
    delete (global as any).Intl;
    delete (global as any).localStorage;
    delete (global as any).sessionStorage;
    delete (global as any).crypto;
    if (jsdom) jsdom.window.close();
  });

  function setMockLocation(url: string) {
    if (jsdom) jsdom.window.close();
    jsdom = new JSDOM(
      "<!DOCTYPE html><html><head><title>Test Page</title></head><body></body></html>",
      { url }
    );
    (global as any).window = jsdom.window;
    (global as any).document = jsdom.window.document;
    (global as any).location = jsdom.window.location;
    (global as any).globalThis = jsdom.window;
  }

  async function getContext(
    factory: EventFactory
  ): Promise<Record<string, any>> {
    const event = (await factory.generatePageEvent(
      undefined,
      undefined,
      {}
    )) as unknown as Record<string, any>;
    return (event.context as Record<string, any>) || {};
  }

  it("blanks scanner payloads injected into every traffic-source param", async () => {
    const payload = encodeURIComponent(ACUNETIX_PAYLOAD);
    setMockLocation(
      `https://formo.so/?twclid=${payload}&gclid=${payload}&fbclid=${payload}&utm_source=${payload}&utm_campaign=${payload}&ref=${payload}`
    );
    const context = await getContext(new EventFactory());

    expect(context.twclid).to.equal("");
    expect(context.gclid).to.equal("");
    expect(context.fbclid).to.equal("");
    expect(context.utm_source).to.equal("");
    expect(context.utm_campaign).to.equal("");
    expect(context.ref).to.equal("");
  });

  it("keeps legitimate values on the same URL", async () => {
    setMockLocation(
      "https://formo.so/?twclid=26cq47zg1e7en9nn2n7dj0y7n1&utm_source=twitter&ref=D7WXN_N4"
    );
    const context = await getContext(new EventFactory());

    expect(context.twclid).to.equal("26cq47zg1e7en9nn2n7dj0y7n1");
    expect(context.utm_source).to.equal("twitter");
    expect(context.ref).to.equal("D7WXN_N4");
  });

  it("does not persist poisoned values as sticky traffic sources", async () => {
    setMockLocation(
      `https://formo.so/?twclid=${encodeURIComponent(ACUNETIX_PAYLOAD)}&utm_source=twitter`
    );
    await getContext(new EventFactory());

    const stored =
      (session().get(SESSION_TRAFFIC_SOURCE_KEY) as Record<string, any>) || {};
    expect(stored.twclid).to.be.undefined;
    expect(stored.utm_source).to.equal("twitter");
  });

  it("flushes poisoned values persisted by a pre-sanitization SDK", async () => {
    // Simulate a sticky session written before sanitization existed. The
    // storage layer serializes objects at runtime (EventFactory persists the
    // traffic-source object the same way), hence the cast.
    session().set(SESSION_TRAFFIC_SOURCE_KEY, {
      twclid: ACUNETIX_PAYLOAD,
      utm_source: "<script>alert(1)</script>",
      ref: "GOODCODE",
    } as unknown as string);
    setMockLocation("https://formo.so/pricing");
    const context = await getContext(new EventFactory());

    expect(context.twclid).to.equal("");
    expect(context.utm_source).to.equal("");
    expect(context.ref).to.equal("GOODCODE");
  });
});
