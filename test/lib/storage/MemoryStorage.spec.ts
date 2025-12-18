import { describe, it, beforeEach } from "mocha";
import { expect } from "chai";
import MemoryStorage from "../../../src/lib/storage/built-in/memory";

describe("MemoryStorage", () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage("test-write-key");
  });

  describe("isAvailable", () => {
    it("should always return true", () => {
      expect(storage.isAvailable()).to.be.true;
    });
  });

  describe("set and get", () => {
    it("should store and retrieve string values", () => {
      storage.set("key1", "value1");
      expect(storage.get("key1")).to.equal("value1");
    });

    it("should store multiple key-value pairs", () => {
      storage.set("key1", "value1");
      storage.set("key2", "value2");
      storage.set("key3", "value3");

      expect(storage.get("key1")).to.equal("value1");
      expect(storage.get("key2")).to.equal("value2");
      expect(storage.get("key3")).to.equal("value3");
    });

    it("should overwrite existing values", () => {
      storage.set("key1", "originalValue");
      expect(storage.get("key1")).to.equal("originalValue");

      storage.set("key1", "newValue");
      expect(storage.get("key1")).to.equal("newValue");
    });

    it("should return null for non-existent keys", () => {
      expect(storage.get("nonExistentKey")).to.be.null;
    });

    it("should handle empty string values", () => {
      storage.set("emptyKey", "");
      // Empty string is falsy, so it returns null due to || null
      expect(storage.get("emptyKey")).to.be.null;
    });

    it("should handle special characters in keys", () => {
      storage.set("key-with-dash", "value1");
      storage.set("key.with.dots", "value2");
      storage.set("key_with_underscore", "value3");

      expect(storage.get("key-with-dash")).to.equal("value1");
      expect(storage.get("key.with.dots")).to.equal("value2");
      expect(storage.get("key_with_underscore")).to.equal("value3");
    });

    it("should handle special characters in values", () => {
      storage.set("key1", "value with spaces");
      storage.set("key2", "value=with=equals");
      storage.set("key3", "value;with;semicolons");

      expect(storage.get("key1")).to.equal("value with spaces");
      expect(storage.get("key2")).to.equal("value=with=equals");
      expect(storage.get("key3")).to.equal("value;with;semicolons");
    });
  });

  describe("remove", () => {
    it("should remove an existing key", () => {
      storage.set("key1", "value1");
      expect(storage.get("key1")).to.equal("value1");

      storage.remove("key1");
      expect(storage.get("key1")).to.be.null;
    });

    it("should not throw when removing non-existent key", () => {
      expect(() => storage.remove("nonExistentKey")).to.not.throw();
    });

    it("should only remove the specified key", () => {
      storage.set("key1", "value1");
      storage.set("key2", "value2");

      storage.remove("key1");

      expect(storage.get("key1")).to.be.null;
      expect(storage.get("key2")).to.equal("value2");
    });
  });

  describe("key isolation", () => {
    it("should prefix keys with writeKey for isolation", () => {
      const storage1 = new MemoryStorage("project1");
      const storage2 = new MemoryStorage("project2");

      storage1.set("sharedKey", "value1");
      storage2.set("sharedKey", "value2");

      expect(storage1.get("sharedKey")).to.equal("value1");
      expect(storage2.get("sharedKey")).to.equal("value2");
    });
  });
});
