import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { JSDOM } from "jsdom";
import WebStorage from "../../../src/lib/storage/built-in/web";
import { secureHash } from "../../../src/utils/hash";
import { JSON_PREFIX, KEY_PREFIX } from "../../../src/lib/storage/constant";

describe("WebStorage", () => {
  let jsdom: JSDOM;
  let storage: WebStorage;

  beforeEach(() => {
    jsdom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
      url: "https://example.com",
    });

    Object.defineProperty(global, "window", {
      value: jsdom.window,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(global, "localStorage", {
      value: jsdom.window.localStorage,
      writable: true,
      configurable: true,
    });

    storage = new WebStorage("test-write-key", jsdom.window.localStorage);
  });

  afterEach(() => {
    jsdom.window.localStorage.clear();
    delete (global as any).window;
    delete (global as any).localStorage;
    if (jsdom) {
      jsdom.window.close();
    }
  });

  describe("isAvailable", () => {
    it("should return true when localStorage is available", () => {
      expect(storage.isAvailable()).to.be.true;
    });

    it("should return false when localStorage throws", () => {
      const mockStorage = {
        setItem: () => {
          throw new Error("Storage disabled");
        },
        removeItem: () => {},
        getItem: () => null,
        clear: () => {},
        key: () => null,
        length: 0,
      };
      const unavailableStorage = new WebStorage("test", mockStorage as Storage);
      expect(unavailableStorage.isAvailable()).to.be.false;
    });
  });

  describe("set and get", () => {
    it("should store and retrieve string values", () => {
      storage.set("key1", "value1");
      expect(storage.get("key1")).to.equal("value1");
    });

    it("should store and retrieve boolean true", () => {
      storage.set("boolKey", true);
      expect(storage.get("boolKey")).to.equal(true);
    });

    it("should store and retrieve boolean false", () => {
      storage.set("boolKey", false);
      expect(storage.get("boolKey")).to.equal(false);
    });

    it("should store and retrieve objects as JSON", () => {
      const testObj = { name: "test", value: 123 };
      storage.set("objKey", testObj);
      expect(storage.get("objKey")).to.deep.equal(testObj);
    });

    it("should store and retrieve arrays as JSON", () => {
      const testArray = [1, 2, 3, "test"];
      storage.set("arrayKey", testArray);
      expect(storage.get("arrayKey")).to.deep.equal(testArray);
    });

    it("should store and retrieve nested objects", () => {
      const nestedObj = {
        level1: {
          level2: {
            value: "deep",
          },
        },
      };
      storage.set("nestedKey", nestedObj);
      expect(storage.get("nestedKey")).to.deep.equal(nestedObj);
    });

    it("should return null for non-existent keys", () => {
      expect(storage.get("nonExistentKey")).to.be.null;
    });

    it("should return null for 'null' string value", () => {
      // Directly set "null" string in localStorage using correct key format
      const writeKey = "test-write-key";
      const storageKey = `${KEY_PREFIX}_${secureHash(writeKey)}_nullKey`;
      jsdom.window.localStorage.setItem(storageKey, "null");
      const testStorage = new WebStorage(writeKey, jsdom.window.localStorage);
      expect(testStorage.get("nullKey")).to.be.null;
    });

    it("should return null for 'undefined' string value", () => {
      const writeKey = "test-write-key";
      const storageKey = `${KEY_PREFIX}_${secureHash(writeKey)}_undefinedKey`;
      jsdom.window.localStorage.setItem(storageKey, "undefined");
      const testStorage = new WebStorage(writeKey, jsdom.window.localStorage);
      expect(testStorage.get("undefinedKey")).to.be.null;
    });

    it("should overwrite existing values", () => {
      storage.set("key1", "original");
      storage.set("key1", "updated");
      expect(storage.get("key1")).to.equal("updated");
    });
  });

  describe("remove", () => {
    it("should remove an existing key", () => {
      storage.set("key1", "value1");
      storage.remove("key1");
      expect(storage.get("key1")).to.be.null;
    });

    it("should not throw when removing non-existent key", () => {
      expect(() => storage.remove("nonExistent")).to.not.throw();
    });
  });

  describe("key isolation", () => {
    it("should prefix keys with writeKey for isolation", () => {
      const storage1 = new WebStorage("project1", jsdom.window.localStorage);
      const storage2 = new WebStorage("project2", jsdom.window.localStorage);

      storage1.set("sharedKey", "value1");
      storage2.set("sharedKey", "value2");

      expect(storage1.get("sharedKey")).to.equal("value1");
      expect(storage2.get("sharedKey")).to.equal("value2");
    });
  });

  describe("JSON parsing error handling", () => {
    it("should return null when JSON parsing fails", () => {
      // Directly set malformed JSON with the correct prefix and key format
      const writeKey = "test-write-key";
      const storageKey = `${KEY_PREFIX}_${secureHash(writeKey)}_malformedKey`;
      jsdom.window.localStorage.setItem(storageKey, `${JSON_PREFIX}{invalid json}`);
      const testStorage = new WebStorage(writeKey, jsdom.window.localStorage);
      expect(testStorage.get("malformedKey")).to.be.null;
    });
  });
});
