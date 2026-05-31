import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { JSDOM } from "jsdom";
import { EventFactory } from "../../../src/event/EventFactory";
import { initStorageManager, session } from "../../../src/storage";
import { SESSION_TRAFFIC_SOURCE_KEY } from "../../../src/constants";

/**
 * Tests for sensitive query-parameter exclusion in page properties.
 *
 * Two layers:
 * - A built-in always-on denylist (privy_oauth_code, privy_oauth_state) that is
 *   stripped regardless of configuration and cannot be disabled.
 * - An opt-in `tracking.excludeQueryParams` array of key names
 *   (case-insensitive).
 *
 * Only the query string is redacted — the URL hash/fragment is intentionally
 * left untouched. Excluded params must not appear in `url`, `query`, or the
 * per-parameter page-property explosion.
 */
describe("EventFactory query parameter exclusion", () => {
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

  function setMockLocation(url: string, referrer?: string) {
    if (jsdom) jsdom.window.close();
    jsdom = new JSDOM(
      "<!DOCTYPE html><html><head><title>Test Page</title></head><body></body></html>",
      referrer ? { url, referrer } : { url }
    );
    (global as any).window = jsdom.window;
    (global as any).document = jsdom.window.document;
    (global as any).location = jsdom.window.location;
    (global as any).globalThis = jsdom.window;
  }

  async function getEvent(
    factory: EventFactory,
    properties: Record<string, any> = {}
  ): Promise<Record<string, any>> {
    return (await factory.generatePageEvent(
      properties.category,
      properties.name,
      properties
    )) as unknown as Record<string, any>;
  }

  async function getProps(
    factory: EventFactory,
    properties: Record<string, any> = {}
  ): Promise<Record<string, any>> {
    const event = await getEvent(factory, properties);
    return (event.properties as Record<string, any>) || {};
  }

  describe("built-in always-on denylist", () => {
    it("always strips Privy OAuth params with no configuration", async () => {
      setMockLocation(
        "https://formo.so/callback?privy_oauth_code=SECRET_CODE&privy_oauth_state=CSRF_TOKEN&privy_oauth_provider=google&foo=bar"
      );
      const props = await getProps(new EventFactory());

      expect(props.url).to.not.contain("SECRET_CODE");
      expect(props.url).to.not.contain("CSRF_TOKEN");
      expect(props.url).to.not.contain("privy_oauth_provider");
      expect(props.query).to.equal("foo=bar");
      expect(props.privy_oauth_code).to.be.undefined;
      expect(props.privy_oauth_state).to.be.undefined;
      expect(props.privy_oauth_provider).to.be.undefined;
      expect(props.foo).to.equal("bar");
    });

    it("matches built-in params case-insensitively", async () => {
      setMockLocation("https://formo.so/callback?PRIVY_OAUTH_CODE=SECRET_CODE&keep=1");
      const props = await getProps(new EventFactory());

      expect(props.url).to.not.contain("SECRET_CODE");
      expect(props.keep).to.equal("1");
    });

    it("leaves the URL hash/fragment untouched", async () => {
      setMockLocation(
        "https://formo.so/callback?privy_oauth_code=SECRET_CODE#privy_oauth_state=HASH_KEPT"
      );
      const props = await getProps(new EventFactory());

      expect(props.url).to.not.contain("SECRET_CODE");
      expect(props.url).to.contain("#privy_oauth_state=HASH_KEPT");
      expect(props.hash).to.equal("#privy_oauth_state=HASH_KEPT");
      expect(props.query).to.equal("");
    });
  });

  describe("excludeQueryParams as an array", () => {
    it("strips configured keys on top of the built-in defaults", async () => {
      setMockLocation(
        "https://formo.so/page?token=ABC&privy_oauth_code=SECRET_CODE&page=2"
      );
      const props = await getProps(
        new EventFactory({ tracking: { excludeQueryParams: ["token"] } })
      );

      expect(props.url).to.not.contain("ABC");
      expect(props.url).to.not.contain("SECRET_CODE");
      expect(props.token).to.be.undefined;
      expect(props.privy_oauth_code).to.be.undefined;
      expect(props.page).to.equal("2");
    });

    it("matches configured keys case-insensitively", async () => {
      setMockLocation("https://formo.so/page?Token=ABC&keep=1");
      const props = await getProps(
        new EventFactory({ tracking: { excludeQueryParams: ["token"] } })
      );

      expect(props.url).to.not.contain("ABC");
      expect(props.keep).to.equal("1");
    });
  });

  // Excluded params must not leak through the event *context* either — not via
  // page_url, not via the referrer, and not via the traffic-source extraction
  // (utm_*, click ids, ref), which parses the URL separately from page props.
  describe("event context redaction", () => {
    it("strips excluded params from context.page_url", async () => {
      setMockLocation(
        "https://formo.so/page?token=ABC&privy_oauth_code=SECRET&keep=1"
      );
      const event = await getEvent(
        new EventFactory({ tracking: { excludeQueryParams: ["token"] } })
      );

      expect(event.context.page_url).to.not.contain("ABC");
      expect(event.context.page_url).to.not.contain("SECRET");
      expect(event.context.page_url).to.contain("keep=1");
    });

    it("does not leak an excluded param that is also a traffic-source key", async () => {
      setMockLocation(
        "https://formo.so/page?utm_source=secretcampaign&gclid=SECRETCLICK&ref=SECRETREF&utm_medium=email"
      );
      const event = await getEvent(
        new EventFactory({
          tracking: { excludeQueryParams: ["utm_source", "gclid", "ref"] },
        })
      );

      // Excluded traffic-source keys are emptied in context...
      expect(event.context.utm_source).to.equal("");
      expect(event.context.gclid).to.equal("");
      expect(event.context.ref).to.equal("");
      // ...while non-excluded traffic-source keys still capture normally.
      expect(event.context.utm_medium).to.equal("email");
    });

    it("strips excluded params from the external referrer", async () => {
      setMockLocation(
        "https://formo.so/page?keep=1",
        "https://referrer.example/landing?token=SECRETTOKEN&campaign=spring"
      );
      const event = await getEvent(
        new EventFactory({ tracking: { excludeQueryParams: ["token"] } })
      );

      expect(event.context.referrer).to.not.contain("SECRETTOKEN");
      expect(event.context.referrer).to.contain("campaign=spring");
    });

    it("strips the always-on privy defaults from the external referrer", async () => {
      setMockLocation(
        "https://formo.so/page?keep=1",
        "https://referrer.example/oauth?privy_oauth_code=SECRETCODE&ok=1"
      );
      const event = await getEvent(new EventFactory());

      expect(event.context.referrer).to.not.contain("SECRETCODE");
      expect(event.context.referrer).to.contain("ok=1");
    });

    it("drops a sticky traffic-source value stored under an earlier, looser config", async () => {
      // First pageview: no exclusion, so gclid is captured and persisted to the
      // sticky SESSION_TRAFFIC_SOURCE_KEY store.
      setMockLocation("https://formo.so/page?gclid=OLDCLICK");
      const first = await getEvent(new EventFactory());
      expect(first.context.gclid).to.equal("OLDCLICK");

      // Later pageview on a clean URL, now excluding gclid. The stored value
      // must not resurface in context from session storage.
      setMockLocation("https://formo.so/page?keep=1");
      const second = await getEvent(
        new EventFactory({ tracking: { excludeQueryParams: ["gclid"] } })
      );
      expect(second.context.gclid).to.equal("");
    });
  });
});
