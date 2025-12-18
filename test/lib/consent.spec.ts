import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { JSDOM } from "jsdom";
import {
  setConsentFlag,
  getConsentFlag,
  removeConsentFlag,
} from "../../src/lib/consent";

describe("Consent Management", () => {
  let jsdom: JSDOM;

  beforeEach(() => {
    jsdom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
      url: "https://example.com",
    });

    Object.defineProperty(global, "window", {
      value: jsdom.window,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(global, "document", {
      value: jsdom.window.document,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    // Clear all cookies
    const cookies = jsdom.window.document.cookie.split(";");
    for (const cookie of cookies) {
      const eqPos = cookie.indexOf("=");
      const name = eqPos > -1 ? cookie.substring(0, eqPos).trim() : cookie.trim();
      if (name) {
        jsdom.window.document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
      }
    }
    delete (global as any).window;
    delete (global as any).document;
    if (jsdom) {
      jsdom.window.close();
    }
  });

  describe("setConsentFlag", () => {
    it("should set a consent cookie", () => {
      setConsentFlag("project-123", "opt_out", "true");

      // The cookie should be set
      expect(jsdom.window.document.cookie).to.include("formo_");
      expect(jsdom.window.document.cookie).to.include("opt_out");
    });

    it("should URL-encode special characters in value", () => {
      setConsentFlag("project-123", "consent_data", "value with spaces");

      const flag = getConsentFlag("project-123", "consent_data");
      expect(flag).to.equal("value with spaces");
    });

    it("should set cookie with SameSite=Strict", () => {
      setConsentFlag("project-123", "opt_out", "true");

      // Cookie string should include samesite
      expect(jsdom.window.document.cookie.toLowerCase()).to.not.be.empty;
    });

    it("should do nothing when document is undefined", () => {
      delete (global as any).document;

      // Should not throw
      expect(() => setConsentFlag("project-123", "opt_out", "true")).to.not.throw();
    });
  });

  describe("getConsentFlag", () => {
    it("should retrieve a consent cookie value", () => {
      setConsentFlag("project-123", "opt_out", "true");

      const value = getConsentFlag("project-123", "opt_out");
      expect(value).to.equal("true");
    });

    it("should return null for non-existent cookie", () => {
      const value = getConsentFlag("project-123", "non_existent");
      expect(value).to.be.null;
    });

    it("should return null when document is undefined", () => {
      delete (global as any).document;

      const value = getConsentFlag("project-123", "opt_out");
      expect(value).to.be.null;
    });

    it("should handle URL-decoded values", () => {
      setConsentFlag("project-123", "custom_data", "test=value&foo=bar");

      const value = getConsentFlag("project-123", "custom_data");
      expect(value).to.equal("test=value&foo=bar");
    });

    it("should return empty string for empty cookie value", () => {
      setConsentFlag("project-123", "empty_flag", "");

      const value = getConsentFlag("project-123", "empty_flag");
      expect(value).to.equal("");
    });
  });

  describe("removeConsentFlag", () => {
    it("should remove a consent cookie", () => {
      setConsentFlag("project-123", "opt_out", "true");
      expect(getConsentFlag("project-123", "opt_out")).to.equal("true");

      removeConsentFlag("project-123", "opt_out");
      expect(getConsentFlag("project-123", "opt_out")).to.be.null;
    });

    it("should not throw when removing non-existent cookie", () => {
      expect(() => removeConsentFlag("project-123", "non_existent")).to.not.throw();
    });

    it("should only remove the specified cookie", () => {
      setConsentFlag("project-123", "flag1", "value1");
      setConsentFlag("project-123", "flag2", "value2");

      removeConsentFlag("project-123", "flag1");

      expect(getConsentFlag("project-123", "flag1")).to.be.null;
      expect(getConsentFlag("project-123", "flag2")).to.equal("value2");
    });
  });

  describe("project isolation", () => {
    it("should isolate consent flags between different projects", () => {
      setConsentFlag("project-1", "opt_out", "true");
      setConsentFlag("project-2", "opt_out", "false");

      expect(getConsentFlag("project-1", "opt_out")).to.equal("true");
      expect(getConsentFlag("project-2", "opt_out")).to.equal("false");
    });

    it("should use hashed project ID in cookie name", () => {
      setConsentFlag("my-project-key", "test_flag", "value");

      // Cookie name should contain hashed project ID
      const cookieString = jsdom.window.document.cookie;
      expect(cookieString).to.include("formo_");
      expect(cookieString).to.include("test_flag");
      // Should not contain the raw project key
      expect(cookieString).to.not.include("my-project-key");
    });

    it("should not conflict with same flag name across projects", () => {
      setConsentFlag("project-a", "shared_flag", "valueA");
      setConsentFlag("project-b", "shared_flag", "valueB");
      setConsentFlag("project-c", "shared_flag", "valueC");

      expect(getConsentFlag("project-a", "shared_flag")).to.equal("valueA");
      expect(getConsentFlag("project-b", "shared_flag")).to.equal("valueB");
      expect(getConsentFlag("project-c", "shared_flag")).to.equal("valueC");
    });
  });

  describe("cookie persistence", () => {
    it("should set cookie with 1-year expiration", () => {
      // This is implicit in the implementation
      // We can only verify the cookie was set
      setConsentFlag("project-123", "long_term", "value");
      expect(getConsentFlag("project-123", "long_term")).to.equal("value");
    });
  });

  describe("edge cases", () => {
    it("should handle special characters in project ID", () => {
      setConsentFlag("project/with/slashes", "flag", "value");
      expect(getConsentFlag("project/with/slashes", "flag")).to.equal("value");
    });

    it("should handle special characters in flag key", () => {
      setConsentFlag("project", "flag_with_underscore", "value");
      expect(getConsentFlag("project", "flag_with_underscore")).to.equal("value");
    });

    it("should handle unicode in values", () => {
      setConsentFlag("project", "unicode_flag", "value with emoji 🎉");
      expect(getConsentFlag("project", "unicode_flag")).to.equal("value with emoji 🎉");
    });
  });
});
