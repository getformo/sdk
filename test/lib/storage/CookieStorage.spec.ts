import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { JSDOM } from "jsdom";
import CookieStorage from "../../../src/lib/storage/built-in/cookie";

describe("CookieStorage", () => {
  let jsdom: JSDOM;
  let storage: CookieStorage;

  beforeEach(() => {
    jsdom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
      url: "https://example.com",
    });

    Object.defineProperty(global, "document", {
      value: jsdom.window.document,
      writable: true,
      configurable: true,
    });

    storage = new CookieStorage("test-write-key");
  });

  afterEach(() => {
    // Clear all cookies
    const cookies = jsdom.window.document.cookie.split(";");
    for (const cookie of cookies) {
      const eqPos = cookie.indexOf("=");
      const name = eqPos > -1 ? cookie.substring(0, eqPos).trim() : cookie.trim();
      jsdom.window.document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
    }
    delete (global as any).document;
    if (jsdom) {
      jsdom.window.close();
    }
  });

  describe("isAvailable", () => {
    it("should return true when document.cookie is available", () => {
      expect(storage.isAvailable()).to.be.true;
    });

    it("should return false when document is undefined", () => {
      delete (global as any).document;
      const unavailableStorage = new CookieStorage("test");
      expect(unavailableStorage.isAvailable()).to.be.false;
    });
  });

  describe("set and get", () => {
    it("should store and retrieve string values", () => {
      storage.set("key1", "value1");
      expect(storage.get("key1")).to.equal("value1");
    });

    it("should handle values with special characters", () => {
      storage.set("key1", "value with spaces");
      expect(storage.get("key1")).to.equal("value with spaces");
    });

    it("should handle URL-encoded values", () => {
      storage.set("key1", "value=with=equals");
      expect(storage.get("key1")).to.equal("value=with=equals");
    });

    it("should return null for non-existent keys", () => {
      expect(storage.get("nonExistentKey")).to.be.null;
    });

    it("should overwrite existing values", () => {
      storage.set("key1", "original");
      storage.set("key1", "updated");
      expect(storage.get("key1")).to.equal("updated");
    });

    it("should store multiple cookies", () => {
      storage.set("key1", "value1");
      storage.set("key2", "value2");
      storage.set("key3", "value3");

      expect(storage.get("key1")).to.equal("value1");
      expect(storage.get("key2")).to.equal("value2");
      expect(storage.get("key3")).to.equal("value3");
    });
  });

  describe("set with options", () => {
    it("should set cookie with expires option", () => {
      const futureDate = new Date(Date.now() + 86400000).toUTCString();
      storage.set("key1", "value1", { expires: futureDate });
      expect(storage.get("key1")).to.equal("value1");
    });

    it("should set cookie with maxAge option", () => {
      storage.set("key1", "value1", { maxAge: 3600 });
      expect(storage.get("key1")).to.equal("value1");
    });

    it("should set cookie with path option", () => {
      storage.set("key1", "value1", { path: "/" });
      expect(storage.get("key1")).to.equal("value1");
    });

    it("should set cookie with sameSite option", () => {
      storage.set("key1", "value1", { sameSite: "strict" });
      expect(storage.get("key1")).to.equal("value1");
    });
  });

  describe("remove", () => {
    it("should remove an existing cookie", () => {
      storage.set("key1", "value1");
      expect(storage.get("key1")).to.equal("value1");

      storage.remove("key1");
      expect(storage.get("key1")).to.be.null;
    });

    it("should not throw when removing non-existent cookie", () => {
      expect(() => storage.remove("nonExistent")).to.not.throw();
    });

    it("should only remove the specified cookie", () => {
      storage.set("key1", "value1");
      storage.set("key2", "value2");

      storage.remove("key1");

      expect(storage.get("key1")).to.be.null;
      expect(storage.get("key2")).to.equal("value2");
    });
  });

  describe("key isolation", () => {
    it("should prefix keys with writeKey for isolation", () => {
      const storage1 = new CookieStorage("project1");
      const storage2 = new CookieStorage("project2");

      storage1.set("sharedKey", "value1");
      storage2.set("sharedKey", "value2");

      expect(storage1.get("sharedKey")).to.equal("value1");
      expect(storage2.get("sharedKey")).to.equal("value2");
    });
  });
});
