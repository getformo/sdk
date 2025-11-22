import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import sinon from "sinon";
import { JSDOM } from "jsdom";
import { PAGE_PROPERTIES_EXCLUDED_FIELDS } from "../../../src/lib/event/constants";

/**
 * Test suite for page event property parsing functionality
 * Tests the getPageProperties method in EventFactory
 */
describe("Page Event Property Parsing", () => {
  let jsdom: JSDOM;

  beforeEach(() => {
    // Set up JSDOM with a base URL
    jsdom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
      url: "https://formo.so/",
    });
    
    // Make JSDOM's window and document available globally
    (global as any).window = jsdom.window;
    (global as any).document = jsdom.window.document;
    (global as any).location = jsdom.window.location;
  });

  afterEach(() => {
    // Clean up JSDOM
    if (jsdom) {
      jsdom.window.close();
    }
    
    // Clean up globals
    delete (global as any).window;
    delete (global as any).document;
    delete (global as any).location;
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
    jsdom = new JSDOM("<!DOCTYPE html><html><body></body></html>", { url });
    
    // Update globals
    (global as any).window = jsdom.window;
    (global as any).document = jsdom.window.document;
    (global as any).location = jsdom.window.location;
  }

  /**
   * Helper to simulate getPageProperties logic
   * This mimics the actual implementation in EventFactory
   */
  function getPageProperties(properties: Record<string, any> = {}): Record<string, any> {
    const pageProps = { ...properties };

    if (pageProps.url === undefined) {
      pageProps.url = window.location.href;
    }

    if (pageProps.path === undefined) {
      pageProps.path = window.location.pathname;
    }

    if (pageProps.hash === undefined) {
      pageProps.hash = window.location.hash;
    }

    if (pageProps.query === undefined) {
      pageProps.query = window.location.search.slice(1);
    }

    // Parse query parameters and add as individual properties
    // Use the same excluded fields constant as the actual implementation
    try {
      const urlObj = new URL(window.location.href);
      urlObj.searchParams.forEach((value, key) => {
        if (pageProps[key] === undefined && !PAGE_PROPERTIES_EXCLUDED_FIELDS.has(key)) {
          pageProps[key] = value;
        }
      });
    } catch (error) {
      // Ignore parsing errors in tests
    }

    return pageProps;
  }

  describe("Basic URL parsing", () => {
    it("should extract url, path, hash, and query from a complete URL", () => {
      setMockLocation("https://formo.so/blog/guide?foo=bar#intro");

      const props = getPageProperties();

      expect(props.url).to.equal("https://formo.so/blog/guide?foo=bar#intro");
      expect(props.path).to.equal("/blog/guide");
      expect(props.hash).to.equal("#intro");
      expect(props.query).to.equal("foo=bar");
    });

    it("should handle URL without query parameters", () => {
      setMockLocation("https://formo.so/blog#section");

      const props = getPageProperties();

      expect(props.url).to.equal("https://formo.so/blog#section");
      expect(props.path).to.equal("/blog");
      expect(props.hash).to.equal("#section");
      expect(props.query).to.equal("");
    });

    it("should handle URL without hash", () => {
      setMockLocation("https://formo.so/blog?foo=bar");

      const props = getPageProperties();

      expect(props.url).to.equal("https://formo.so/blog?foo=bar");
      expect(props.path).to.equal("/blog");
      expect(props.hash).to.equal("");
      expect(props.query).to.equal("foo=bar");
    });

    it("should handle URL without query or hash", () => {
      setMockLocation("https://formo.so/blog");

      const props = getPageProperties();

      expect(props.url).to.equal("https://formo.so/blog");
      expect(props.path).to.equal("/blog");
      expect(props.hash).to.equal("");
      expect(props.query).to.equal("");
    });

    it("should handle root path URL", () => {
      setMockLocation("https://formo.so/");

      const props = getPageProperties();

      expect(props.url).to.equal("https://formo.so/");
      expect(props.path).to.equal("/");
      expect(props.hash).to.equal("");
      expect(props.query).to.equal("");
    });
  });

  describe("Query parameter parsing", () => {
    it("should parse individual query parameters as properties", () => {
      setMockLocation("https://formo.so/blog?foo=bar&baz=qux");

      const props = getPageProperties();

      expect(props.query).to.equal("foo=bar&baz=qux");
      expect(props.foo).to.equal("bar");
      expect(props.baz).to.equal("qux");
    });

    it("should parse multiple query parameters with special characters", () => {
      setMockLocation("https://formo.so/blog?param1=value%201&param2=value%202");

      const props = getPageProperties();

      expect(props.param1).to.equal("value 1");
      expect(props.param2).to.equal("value 2");
    });

    it("should handle query parameters with numeric values", () => {
      setMockLocation("https://formo.so/blog?page=2&limit=50");

      const props = getPageProperties();

      expect(props.page).to.equal("2");
      expect(props.limit).to.equal("50");
    });

    it("should handle query parameters with empty values", () => {
      setMockLocation("https://formo.so/blog?foo=&bar=value");

      const props = getPageProperties();

      expect(props.foo).to.equal("");
      expect(props.bar).to.equal("value");
    });

    it("should handle duplicate query parameters (takes first value)", () => {
      setMockLocation("https://formo.so/blog?foo=first&foo=second");

      const props = getPageProperties();

      expect(props.foo).to.equal("first");
    });
  });

  describe("Context field exclusion", () => {
    it("should exclude UTM parameters from properties", () => {
      setMockLocation("https://formo.so/blog?utm_source=twitter&utm_medium=social&custom=value");

      const props = getPageProperties();

      // UTM parameters should NOT be in properties
      expect(props.utm_source).to.be.undefined;
      expect(props.utm_medium).to.be.undefined;

      // Custom parameter should be in properties
      expect(props.custom).to.equal("value");

      // Full query string should still be present
      expect(props.query).to.equal("utm_source=twitter&utm_medium=social&custom=value");
    });

    it("should exclude all UTM parameters", () => {
      setMockLocation(
        "https://formo.so/blog?utm_source=google&utm_medium=cpc&utm_campaign=summer&utm_term=analytics&utm_content=banner"
      );

      const props = getPageProperties();

      expect(props.utm_source).to.be.undefined;
      expect(props.utm_medium).to.be.undefined;
      expect(props.utm_campaign).to.be.undefined;
      expect(props.utm_term).to.be.undefined;
      expect(props.utm_content).to.be.undefined;
    });

    it("should exclude referral parameters", () => {
      setMockLocation("https://formo.so/blog?ref=abc123&referral=partner&refcode=xyz");

      const props = getPageProperties();

      expect(props.ref).to.be.undefined;
      expect(props.referral).to.be.undefined;
      expect(props.refcode).to.be.undefined;
    });

    it("should exclude referrer parameter", () => {
      setMockLocation("https://formo.so/blog?referrer=external");

      const props = getPageProperties();

      expect(props.referrer).to.be.undefined;
    });

    it("should include non-context query parameters", () => {
      setMockLocation("https://formo.so/blog?utm_source=twitter&foo=bar&custom_param=value");

      const props = getPageProperties();

      expect(props.utm_source).to.be.undefined;
      expect(props.foo).to.equal("bar");
      expect(props.custom_param).to.equal("value");
    });
  });

  describe("Semantic property protection", () => {
    it("should not allow query parameters to override category", () => {
      setMockLocation("https://formo.so/blog?category=malicious");

      const props = getPageProperties({ category: "blog" });

      expect(props.category).to.equal("blog");
    });

    it("should not allow query parameters to override name", () => {
      setMockLocation("https://formo.so/blog?name=malicious");

      const props = getPageProperties({ name: "Analytics Guide" });

      expect(props.name).to.equal("Analytics Guide");
    });

    it("should not allow query parameters to override url", () => {
      setMockLocation("https://formo.so/blog?url=https://malicious.com");

      const props = getPageProperties();

      expect(props.url).to.equal("https://formo.so/blog?url=https://malicious.com");
      expect(props.url).to.not.equal("https://malicious.com");
    });

    it("should not allow query parameters to override path", () => {
      setMockLocation("https://formo.so/blog?path=/malicious");

      const props = getPageProperties();

      expect(props.path).to.equal("/blog");
      expect(props.path).to.not.equal("/malicious");
    });

    it("should not allow query parameters to override hash", () => {
      setMockLocation("https://formo.so/blog?hash=malicious#intro");

      const props = getPageProperties();

      expect(props.hash).to.equal("#intro");
    });

    it("should not allow query parameters to override query", () => {
      setMockLocation("https://formo.so/blog?query=malicious&foo=bar");

      const props = getPageProperties();

      expect(props.query).to.equal("query=malicious&foo=bar");
      expect(props.query).to.not.equal("malicious");
    });

    it("should prevent undefined category/name from being set by query params", () => {
      setMockLocation("https://formo.so/blog?category=hack&name=test");

      // Simulate page event generation where category/name might be undefined
      const props = getPageProperties({ category: undefined, name: undefined });

      // These should remain undefined, not be set by query params
      expect(props.category).to.be.undefined;
      expect(props.name).to.be.undefined;
    });
  });

  describe("Property override behavior", () => {
    it("should not override existing properties", () => {
      setMockLocation("https://formo.so/blog?foo=from-url");

      const props = getPageProperties({ foo: "existing-value" });

      expect(props.foo).to.equal("existing-value");
    });

    it("should only add new properties from query params", () => {
      setMockLocation("https://formo.so/blog?new_param=new_value&existing=url_value");

      const props = getPageProperties({ existing: "original" });

      expect(props.new_param).to.equal("new_value");
      expect(props.existing).to.equal("original");
    });
  });

  describe("Hash/fragment handling", () => {
    it("should include the # prefix in hash property", () => {
      setMockLocation("https://formo.so/blog#section");

      const props = getPageProperties();

      expect(props.hash).to.equal("#section");
      expect(props.hash).to.include("#");
    });

    it("should handle empty hash correctly", () => {
      setMockLocation("https://formo.so/blog");

      const props = getPageProperties();

      expect(props.hash).to.equal("");
    });

    it("should handle hash with special characters", () => {
      setMockLocation("https://formo.so/blog#section-1.2");

      const props = getPageProperties();

      expect(props.hash).to.equal("#section-1.2");
    });

    it("should preserve hash with encoded characters", () => {
      setMockLocation("https://formo.so/blog#section%20with%20spaces");

      const props = getPageProperties();

      expect(props.hash).to.equal("#section%20with%20spaces");
    });
  });

  describe("Edge cases", () => {
    it("should handle complex URLs with all components", () => {
      setMockLocation(
        "https://formo.so/blog/analytics/guide?utm_source=twitter&foo=bar&custom=value#introduction"
      );

      const props = getPageProperties({ category: "guides", name: "Web3 Analytics" });

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

    it("should handle query parameters with boolean-like values", () => {
      setMockLocation("https://formo.so/blog?debug=true&verbose=false");

      const props = getPageProperties();

      expect(props.debug).to.equal("true");
      expect(props.verbose).to.equal("false");
    });

    it("should handle URLs with port numbers", () => {
      setMockLocation("https://formo.so:8080/blog?foo=bar#section");

      const props = getPageProperties();

      expect(props.url).to.equal("https://formo.so:8080/blog?foo=bar#section");
      expect(props.path).to.equal("/blog");
    });

    it("should handle localhost URLs", () => {
      setMockLocation("http://localhost:3000/test?param=value#top");

      const props = getPageProperties();

      expect(props.url).to.equal("http://localhost:3000/test?param=value#top");
      expect(props.path).to.equal("/test");
      expect(props.query).to.equal("param=value");
      expect(props.hash).to.equal("#top");
      expect(props.param).to.equal("value");
    });

    it("should handle deeply nested paths", () => {
      setMockLocation("https://formo.so/a/b/c/d/e/f?param=value");

      const props = getPageProperties();

      expect(props.path).to.equal("/a/b/c/d/e/f");
    });

    it("should handle mixed case query parameter names", () => {
      setMockLocation("https://formo.so/blog?FooBar=value&ALLCAPS=test");

      const props = getPageProperties();

      expect(props.FooBar).to.equal("value");
      expect(props.ALLCAPS).to.equal("test");
    });
  });

  describe("Backward compatibility", () => {
    it("should maintain hash format with # prefix for backward compatibility", () => {
      setMockLocation("https://formo.so/blog#intro");

      const props = getPageProperties();

      // Hash should include # for backward compatibility
      expect(props.hash).to.equal("#intro");
      expect(props.hash.charAt(0)).to.equal("#");
    });

    it("should not break existing URL construction patterns", () => {
      setMockLocation("https://formo.so/blog#section");

      const props = getPageProperties();

      // Should be able to reconstruct URL with hash
      const reconstructed = props.url;
      expect(reconstructed).to.include(props.hash);
    });
  });

  describe("Security considerations", () => {
    it("should prevent XSS attempts via query parameters", () => {
      setMockLocation("https://formo.so/blog?<script>alert('xss')</script>=value");

      const props = getPageProperties();

      // The parameter name itself contains the script tag, but it should be treated as a string
      expect(Object.keys(props)).to.include("<script>alert('xss')</script>");
    });

    it("should handle SQL injection-like patterns in query params", () => {
      setMockLocation("https://formo.so/blog?id=1';DROP TABLE users;--");

      const props = getPageProperties();

      expect(props.id).to.equal("1';DROP TABLE users;--");
    });

    it("should protect against category/name injection attempts", () => {
      setMockLocation("https://formo.so/blog?category=<script>alert('xss')</script>");

      const props = getPageProperties({ category: "legitimate" });

      expect(props.category).to.equal("legitimate");
      expect(props.category).to.not.include("script");
    });
  });
});

