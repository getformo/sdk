import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { JSDOM } from "jsdom";
import { EventFactory } from "../../../src/event/EventFactory";
import { initStorageManager, session } from "../../../src/storage";
import { SESSION_TRAFFIC_SOURCE_KEY } from "../../../src/constants";

/**
 * Test suite for page event property parsing functionality
 * Tests the actual EventFactory.generatePageEvent method
 */
describe("Page Event Property Parsing", () => {
  let jsdom: JSDOM;
  let eventFactory: EventFactory;

  beforeEach(() => {
    // Set up JSDOM with a base URL
    jsdom = new JSDOM("<!DOCTYPE html><html><head><title>Test Page</title></head><body></body></html>", {
      url: "https://formo.so/",
    });
    
    // Make JSDOM's window and document available globally
    Object.defineProperty(global, 'window', {
      value: jsdom.window,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(global, 'document', {
      value: jsdom.window.document,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(global, 'location', {
      value: jsdom.window.location,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(global, 'globalThis', {
      value: jsdom.window,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(global, 'navigator', {
      value: jsdom.window.navigator,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(global, 'screen', {
      value: jsdom.window.screen,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(global, 'devicePixelRatio', {
      value: 1,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(global, 'innerWidth', {
      value: 1920,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(global, 'innerHeight', {
      value: 1080,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(global, 'Intl', {
      value: {
        DateTimeFormat: () => ({
          resolvedOptions: () => ({ timeZone: "America/New_York" }),
        }),
      },
      writable: true,
      configurable: true,
    });
    Object.defineProperty(global, 'localStorage', {
      value: jsdom.window.localStorage,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(global, 'sessionStorage', {
      value: jsdom.window.sessionStorage,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(global, 'crypto', {
      value: {
        randomUUID: () => "12345678-1234-1234-1234-123456789abc",
      },
      writable: true,
      configurable: true,
    });

    // Initialize StorageManager
    initStorageManager('test-write-key');
    
    // Create EventFactory instance
    eventFactory = new EventFactory();
  });

  afterEach(() => {
    // Clean up globals
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

    // Clean up JSDOM
    if (jsdom) {
      jsdom.window.close();
    }
  });

  /**
   * Helper function to set mock location by creating a new JSDOM with the desired URL
   */
  function setMockLocation(url: string) {
    // Close previous JSDOM
    if (jsdom) {
      jsdom.window.close();
    }
    
    // Create new JSDOM with the desired URL
    jsdom = new JSDOM("<!DOCTYPE html><html><head><title>Test Page</title></head><body></body></html>", { url });
    
    // Update globals
    (global as any).window = jsdom.window;
    (global as any).document = jsdom.window.document;
    (global as any).location = jsdom.window.location;
    (global as any).globalThis = jsdom.window;
  }

  /**
   * Helper to test page properties through the actual EventFactory.generatePageEvent method
   */
  async function getPageProperties(properties: Record<string, any> = {}): Promise<Record<string, any>> {
    const event = await eventFactory.generatePageEvent(
      properties.category,
      properties.name,
      properties
    );

    return event.properties || {};
  }

  /**
   * Helper to get the event context populated by EventFactory.generatePageEvent
   */
  async function getPageContext(properties: Record<string, any> = {}): Promise<Record<string, any>> {
    const event = await eventFactory.generatePageEvent(
      properties.category,
      properties.name,
      properties
    );

    return (event.context as Record<string, any>) || {};
  }

  describe("Basic URL parsing", () => {
    it("should extract url, path, hash, and query from a complete URL", async () => {
      setMockLocation("https://formo.so/blog/guide?foo=bar#intro");

      const props = await getPageProperties();

      expect(props.url).to.equal("https://formo.so/blog/guide?foo=bar#intro");
      expect(props.path).to.equal("/blog/guide");
      expect(props.hash).to.equal("#intro");
      expect(props.query).to.equal("foo=bar");
    });

    it("should handle URL without query parameters", async () => {
      setMockLocation("https://formo.so/blog#section");

      const props = await getPageProperties();

      expect(props.url).to.equal("https://formo.so/blog#section");
      expect(props.path).to.equal("/blog");
      expect(props.hash).to.equal("#section");
      expect(props.query).to.equal("");
    });

    it("should handle URL without hash", async () => {
      setMockLocation("https://formo.so/blog?foo=bar");

      const props = await getPageProperties();

      expect(props.url).to.equal("https://formo.so/blog?foo=bar");
      expect(props.path).to.equal("/blog");
      expect(props.hash).to.equal("");
      expect(props.query).to.equal("foo=bar");
    });

    it("should handle URL without query or hash", async () => {
      setMockLocation("https://formo.so/blog");

      const props = await getPageProperties();

      expect(props.url).to.equal("https://formo.so/blog");
      expect(props.path).to.equal("/blog");
      expect(props.hash).to.equal("");
      expect(props.query).to.equal("");
    });

    it("should handle root path URL", async () => {
      setMockLocation("https://formo.so/");

      const props = await getPageProperties();

      expect(props.url).to.equal("https://formo.so/");
      expect(props.path).to.equal("/");
      expect(props.hash).to.equal("");
      expect(props.query).to.equal("");
    });
  });

  describe("Query parameter parsing", () => {
    it("should parse individual query parameters as properties", async () => {
      setMockLocation("https://formo.so/blog?foo=bar&baz=qux");

      const props = await getPageProperties();

      expect(props.query).to.equal("foo=bar&baz=qux");
      expect(props.foo).to.equal("bar");
      expect(props.baz).to.equal("qux");
    });

    it("should parse multiple query parameters with special characters", async () => {
      setMockLocation("https://formo.so/blog?param1=value%201&param2=value%202");

      const props = await getPageProperties();

      expect(props.param1).to.equal("value 1");
      expect(props.param2).to.equal("value 2");
    });

    it("should handle query parameters with numeric values", async () => {
      setMockLocation("https://formo.so/blog?page=2&limit=50");

      const props = await getPageProperties();

      expect(props.page).to.equal("2");
      expect(props.limit).to.equal("50");
    });

    it("should handle query parameters with empty values", async () => {
      setMockLocation("https://formo.so/blog?foo=&bar=value");

      const props = await getPageProperties();

      expect(props.foo).to.equal("");
      expect(props.bar).to.equal("value");
    });

    it("should handle duplicate query parameters (takes first value)", async () => {
      setMockLocation("https://formo.so/blog?foo=first&foo=second");

      const props = await getPageProperties();

      expect(props.foo).to.equal("first");
    });
  });

  describe("Context field exclusion", () => {
    it("should exclude UTM parameters from properties", async () => {
      setMockLocation("https://formo.so/blog?utm_source=twitter&utm_medium=social&custom=value");

      const props = await getPageProperties();

      // UTM parameters should NOT be in properties
      expect(props.utm_source).to.be.undefined;
      expect(props.utm_medium).to.be.undefined;

      // Custom parameter should be in properties
      expect(props.custom).to.equal("value");

      // Full query string should still be present
      expect(props.query).to.equal("utm_source=twitter&utm_medium=social&custom=value");
    });

    it("should exclude all UTM parameters", async () => {
      setMockLocation(
        "https://formo.so/blog?utm_source=google&utm_medium=cpc&utm_campaign=summer&utm_term=analytics&utm_content=banner"
      );

      const props = await getPageProperties();

      expect(props.utm_source).to.be.undefined;
      expect(props.utm_medium).to.be.undefined;
      expect(props.utm_campaign).to.be.undefined;
      expect(props.utm_term).to.be.undefined;
      expect(props.utm_content).to.be.undefined;
    });

    it("should exclude referral parameters", async () => {
      setMockLocation("https://formo.so/blog?ref=abc123&referral=partner&refcode=xyz");

      const props = await getPageProperties();

      expect(props.ref).to.be.undefined;
      expect(props.referral).to.be.undefined;
      expect(props.refcode).to.be.undefined;
    });

    it("should exclude referrer parameter", async () => {
      setMockLocation("https://formo.so/blog?referrer=external");

      const props = await getPageProperties();

      expect(props.referrer).to.be.undefined;
    });

    it("should include non-context query parameters", async () => {
      setMockLocation("https://formo.so/blog?utm_source=twitter&foo=bar&custom_param=value");

      const props = await getPageProperties();

      expect(props.utm_source).to.be.undefined;
      expect(props.foo).to.equal("bar");
      expect(props.custom_param).to.equal("value");
    });
  });

  describe("Semantic property protection", () => {
    it("should not allow query parameters to override category", async () => {
      setMockLocation("https://formo.so/blog?category=malicious");

      const props = await getPageProperties({ category: "blog" });

      expect(props.category).to.equal("blog");
    });

    it("should not allow query parameters to override name", async () => {
      setMockLocation("https://formo.so/blog?name=malicious");

      const props = await getPageProperties({ name: "Analytics Guide" });

      expect(props.name).to.equal("Analytics Guide");
    });

    it("should not allow query parameters to override url", async () => {
      setMockLocation("https://formo.so/blog?url=https://malicious.com");

      const props = await getPageProperties();

      expect(props.url).to.equal("https://formo.so/blog?url=https://malicious.com");
      expect(props.url).to.not.equal("https://malicious.com");
    });

    it("should not allow query parameters to override path", async () => {
      setMockLocation("https://formo.so/blog?path=/malicious");

      const props = await getPageProperties();

      expect(props.path).to.equal("/blog");
      expect(props.path).to.not.equal("/malicious");
    });

    it("should not allow query parameters to override hash", async () => {
      setMockLocation("https://formo.so/blog?hash=malicious#intro");

      const props = await getPageProperties();

      expect(props.hash).to.equal("#intro");
    });

    it("should not allow query parameters to override query", async () => {
      setMockLocation("https://formo.so/blog?query=malicious&foo=bar");

      const props = await getPageProperties();

      expect(props.query).to.equal("query=malicious&foo=bar");
      expect(props.query).to.not.equal("malicious");
    });

    it("should prevent undefined category/name from being set by query params", async () => {
      setMockLocation("https://formo.so/blog?category=hack&name=test");

      // Simulate page event generation where category/name might be undefined
      const props = await getPageProperties({ category: undefined, name: undefined });

      // These should remain undefined, not be set by query params
      expect(props.category).to.be.undefined;
      expect(props.name).to.be.undefined;
    });
  });

  describe("Property override behavior", () => {
    it("should not override existing properties", async () => {
      setMockLocation("https://formo.so/blog?foo=from-url");

      const props = await getPageProperties({ foo: "existing-value" });

      expect(props.foo).to.equal("existing-value");
    });

    it("should only add new properties from query params", async () => {
      setMockLocation("https://formo.so/blog?new_param=new_value&existing=url_value");

      const props = await getPageProperties({ existing: "original" });

      expect(props.new_param).to.equal("new_value");
      expect(props.existing).to.equal("original");
    });
  });

  describe("Hash/fragment handling", () => {
    it("should include the # prefix in hash property", async () => {
      setMockLocation("https://formo.so/blog#section");

      const props = await getPageProperties();

      expect(props.hash).to.equal("#section");
      expect(props.hash).to.include("#");
    });

    it("should handle empty hash correctly", async () => {
      setMockLocation("https://formo.so/blog");

      const props = await getPageProperties();

      expect(props.hash).to.equal("");
    });

    it("should handle hash with special characters", async () => {
      setMockLocation("https://formo.so/blog#section-1.2");

      const props = await getPageProperties();

      expect(props.hash).to.equal("#section-1.2");
    });

    it("should preserve hash with encoded characters", async () => {
      setMockLocation("https://formo.so/blog#section%20with%20spaces");

      const props = await getPageProperties();

      expect(props.hash).to.equal("#section%20with%20spaces");
    });
  });

  describe("Edge cases", () => {
    it("should handle complex URLs with all components", async () => {
      setMockLocation(
        "https://formo.so/blog/analytics/guide?utm_source=twitter&foo=bar&custom=value#introduction"
      );

      const props = await getPageProperties({ category: "guides", name: "Web3 Analytics" });

      expect(props.url).to.equal(
        "https://formo.so/blog/analytics/guide?utm_source=twitter&foo=bar&custom=value#introduction"
      );
      expect(props.path).to.equal("/blog/analytics/guide");
      expect(props.hash).to.equal("#introduction");
      expect(props.query).to.equal("utm_source=twitter&foo=bar&custom=value");
      expect(props.category).to.equal("guides");
      expect(props.name).to.equal("Web3 Analytics");
      expect(props.utm_source).to.be.undefined; // Excluded
      expect(props.foo).to.equal("bar"); // Included
      expect(props.custom).to.equal("value"); // Included
    });

    it("should handle query parameters with boolean-like values", async () => {
      setMockLocation("https://formo.so/blog?debug=true&verbose=false");

      const props = await getPageProperties();

      expect(props.debug).to.equal("true");
      expect(props.verbose).to.equal("false");
    });

    it("should handle URLs with port numbers", async () => {
      setMockLocation("https://formo.so:8080/blog?foo=bar#section");

      const props = await getPageProperties();

      expect(props.url).to.equal("https://formo.so:8080/blog?foo=bar#section");
      expect(props.path).to.equal("/blog");
    });

    it("should handle localhost URLs", async () => {
      setMockLocation("http://localhost:3000/test?param=value#top");

      const props = await getPageProperties();

      expect(props.url).to.equal("http://localhost:3000/test?param=value#top");
      expect(props.path).to.equal("/test");
      expect(props.query).to.equal("param=value");
      expect(props.hash).to.equal("#top");
      expect(props.param).to.equal("value");
    });

    it("should handle deeply nested paths", async () => {
      setMockLocation("https://formo.so/a/b/c/d/e/f?param=value");

      const props = await getPageProperties();

      expect(props.path).to.equal("/a/b/c/d/e/f");
    });

    it("should handle mixed case query parameter names", async () => {
      setMockLocation("https://formo.so/blog?FooBar=value&ALLCAPS=test");

      const props = await getPageProperties();

      // EventFactory converts all properties to snake_case
      expect(props.foo_bar).to.equal("value");
      expect(props.allcaps).to.equal("test");
    });
  });

  describe("Backward compatibility", () => {
    it("should maintain hash format with # prefix for backward compatibility", async () => {
      setMockLocation("https://formo.so/blog#intro");

      const props = await getPageProperties();

      // Hash should include # for backward compatibility
      expect(props.hash).to.equal("#intro");
      expect(props.hash.charAt(0)).to.equal("#");
    });

    it("should not break existing URL construction patterns", async () => {
      setMockLocation("https://formo.so/blog#section");

      const props = await getPageProperties();

      // Should be able to reconstruct URL with hash
      const reconstructed = props.url;
      expect(reconstructed).to.include(props.hash);
    });
  });

  describe("Security considerations", () => {
    it("should prevent XSS attempts via query parameters", async () => {
      setMockLocation("https://formo.so/blog?<script>alert('xss')</script>=value");

      const props = await getPageProperties();

      // The parameter name itself contains the script tag, but it should be treated as a string
      expect(Object.keys(props)).to.include("<script>alert('xss')</script>");
    });

    it("should handle SQL injection-like patterns in query params", async () => {
      setMockLocation("https://formo.so/blog?id=1';DROP TABLE users;--");

      const props = await getPageProperties();

      expect(props.id).to.equal("1';DROP TABLE users;--");
    });

    it("should protect against category/name injection attempts", async () => {
      setMockLocation("https://formo.so/blog?category=<script>alert('xss')</script>");

      const props = await getPageProperties({ category: "legitimate" });

      expect(props.category).to.equal("legitimate");
      expect(props.category).to.not.include("script");
    });
  });

  describe("Properties object mutation", () => {
    it("should not mutate the original properties object", async () => {
      setMockLocation("https://formo.so/blog?foo=bar#intro");

      const originalProps = { category: "test", custom: "value" };
      const originalPropsCopy = { ...originalProps };

      await getPageProperties(originalProps);

      // Original object should be unchanged
      expect(originalProps).to.deep.equal(originalPropsCopy);
      expect((originalProps as any).url).to.be.undefined;
      expect((originalProps as any).path).to.be.undefined;
      expect((originalProps as any).hash).to.be.undefined;
      expect((originalProps as any).query).to.be.undefined;
      expect((originalProps as any).foo).to.be.undefined;
    });

    it("should allow reusing properties object across multiple calls", async () => {
      const reusableProps = { category: "page_view" };

      // First call with one URL
      setMockLocation("https://formo.so/page1?param1=value1");
      const props1 = await getPageProperties(reusableProps);

      expect(props1.path).to.equal("/page1");
      expect(props1.param1).to.equal("value1");

      // Second call with different URL - should get new values
      setMockLocation("https://formo.so/page2?param2=value2");
      const props2 = await getPageProperties(reusableProps);

      expect(props2.path).to.equal("/page2");
      expect(props2.param2).to.equal("value2");
      // Should not have param1 from first call
      expect((props2 as any).param1).to.be.undefined;
    });
  });

  describe("Click ID parameters (sticky across session)", () => {
    // The StorageManager is a singleton that persists across tests and retains
    // traffic-source entries from earlier tests. Clear that key before each test
    // so persistence behaviour can be asserted cleanly.
    beforeEach(() => {
      try {
        session().remove(SESSION_TRAFFIC_SOURCE_KEY);
      } catch {}
    });

    it("should capture click IDs into context on the landing pageview", async () => {
      setMockLocation("https://formo.so/?gclid=test123&fbclid=fb456");

      const context = await getPageContext();

      expect(context.gclid).to.equal("test123");
      expect(context.fbclid).to.equal("fb456");
    });

    it("should exclude click IDs from page properties", async () => {
      setMockLocation("https://formo.so/?gclid=test123&fbclid=fb456&custom=keep");

      const props = await getPageProperties();

      expect(props.gclid).to.be.undefined;
      expect(props.fbclid).to.be.undefined;
      // Non-click-ID query params still pass through
      expect(props.custom).to.equal("keep");
    });

    it("should persist click IDs across subsequent pageviews in the same session", async () => {
      // Landing page has the click ID
      setMockLocation("https://formo.so/?gclid=test123");
      const landingContext = await getPageContext();
      expect(landingContext.gclid).to.equal("test123");

      // Navigate to a second page without the click ID; sessionStorage persists because
      // setMockLocation creates a new JSDOM window. Carry sessionStorage over explicitly
      // to simulate same-session navigation.
      const storedTrafficSource = jsdom.window.sessionStorage.getItem("traffic-source");

      setMockLocation("https://formo.so/dashboard");
      if (storedTrafficSource) {
        jsdom.window.sessionStorage.setItem("traffic-source", storedTrafficSource);
      }
      (global as any).sessionStorage = jsdom.window.sessionStorage;
      initStorageManager("test-write-key");
      eventFactory = new EventFactory();

      const secondContext = await getPageContext();
      expect(secondContext.gclid).to.equal("test123");
    });

    it("should not leak click IDs into a fresh session", async () => {
      // Landing page has the click ID, which gets written to sessionStorage
      setMockLocation("https://formo.so/?gclid=test123");
      await getPageContext();

      // Simulate a brand new session (new tab): sessionStorage is empty
      session().remove(SESSION_TRAFFIC_SOURCE_KEY);

      setMockLocation("https://formo.so/dashboard");
      const freshContext = await getPageContext();
      expect(freshContext.gclid).to.equal("");
    });

    it("should let a newer click ID override the stored value", async () => {
      // First pageview stores gclid=old
      setMockLocation("https://formo.so/?gclid=old");
      const firstContext = await getPageContext();
      expect(firstContext.gclid).to.equal("old");

      // Carry sessionStorage over to next pageview and send a new gclid
      const storedTrafficSource = jsdom.window.sessionStorage.getItem("traffic-source");
      setMockLocation("https://formo.so/landing?gclid=new");
      if (storedTrafficSource) {
        jsdom.window.sessionStorage.setItem("traffic-source", storedTrafficSource);
      }
      (global as any).sessionStorage = jsdom.window.sessionStorage;
      initStorageManager("test-write-key");
      eventFactory = new EventFactory();

      const secondContext = await getPageContext();
      expect(secondContext.gclid).to.equal("new");
    });

    it("should capture each supported click ID vendor param", async () => {
      setMockLocation(
        "https://formo.so/?gclid=g1&gad_source=g2&gbraid=g3&wbraid=g4&dclid=g5&fbclid=f1&msclkid=m1&yclid=y1&ttclid=t1&twclid=t2&li_fat_id=l1&rdt_cid=r1"
      );

      const context = await getPageContext();

      expect(context.gclid).to.equal("g1");
      expect(context.gad_source).to.equal("g2");
      expect(context.gbraid).to.equal("g3");
      expect(context.wbraid).to.equal("g4");
      expect(context.dclid).to.equal("g5");
      expect(context.fbclid).to.equal("f1");
      expect(context.msclkid).to.equal("m1");
      expect(context.yclid).to.equal("y1");
      expect(context.ttclid).to.equal("t1");
      expect(context.twclid).to.equal("t2");
      expect(context.li_fat_id).to.equal("l1");
      expect(context.rdt_cid).to.equal("r1");
    });

    it("should default missing click IDs to empty string", async () => {
      setMockLocation("https://formo.so/?gclid=only");

      const context = await getPageContext();

      expect(context.gclid).to.equal("only");
      expect(context.fbclid).to.equal("");
      expect(context.msclkid).to.equal("");
      expect(context.rdt_cid).to.equal("");
    });

    it("should not capture unknown attribution-like params as click IDs", async () => {
      setMockLocation("https://formo.so/?random_clid=abc");

      const context = await getPageContext();

      expect(context.random_clid).to.be.undefined;
    });
  });
});

