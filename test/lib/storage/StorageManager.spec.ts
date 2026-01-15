import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import { JSDOM } from "jsdom";
import { StorageManager } from "../../../src/storage/StorageManager";

describe("StorageManager", () => {
  let jsdom: JSDOM;
  let storageManager: StorageManager;

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
    Object.defineProperty(global, "localStorage", {
      value: jsdom.window.localStorage,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(global, "sessionStorage", {
      value: jsdom.window.sessionStorage,
      writable: true,
      configurable: true,
    });

    storageManager = new StorageManager("test-write-key");
  });

  afterEach(() => {
    delete (global as any).window;
    delete (global as any).document;
    delete (global as any).localStorage;
    delete (global as any).sessionStorage;
    sinon.restore();
    if (jsdom) {
      jsdom.window.close();
    }
  });

  describe("getStorage", () => {
    it("should return cookie storage when requested and available", () => {
      const storage = storageManager.getStorage("cookieStorage");
      expect(storage).to.not.be.null;
      expect(storage.isAvailable()).to.be.true;
    });

    it("should return localStorage when requested and available", () => {
      const storage = storageManager.getStorage("localStorage");
      expect(storage).to.not.be.null;
      expect(storage.isAvailable()).to.be.true;
    });

    it("should return sessionStorage when requested and available", () => {
      const storage = storageManager.getStorage("sessionStorage");
      expect(storage).to.not.be.null;
      expect(storage.isAvailable()).to.be.true;
    });

    it("should return memoryStorage when requested", () => {
      const storage = storageManager.getStorage("memoryStorage");
      expect(storage).to.not.be.null;
      expect(storage.isAvailable()).to.be.true;
    });

    it("should cache storage instances", () => {
      const storage1 = storageManager.getStorage("localStorage");
      const storage2 = storageManager.getStorage("localStorage");
      expect(storage1).to.equal(storage2);
    });

    it("should return different instances for different storage types", () => {
      const localStorage = storageManager.getStorage("localStorage");
      const sessionStorage = storageManager.getStorage("sessionStorage");
      expect(localStorage).to.not.equal(sessionStorage);
    });
  });

  describe("storage operations", () => {
    it("should set and get values from localStorage", () => {
      const storage = storageManager.getStorage("localStorage");
      storage.set("testKey", "testValue");
      expect(storage.get("testKey")).to.equal("testValue");
    });

    it("should set and get values from sessionStorage", () => {
      const storage = storageManager.getStorage("sessionStorage");
      storage.set("testKey", "testValue");
      expect(storage.get("testKey")).to.equal("testValue");
    });

    it("should set and get values from memoryStorage", () => {
      const storage = storageManager.getStorage("memoryStorage");
      storage.set("testKey", "testValue");
      expect(storage.get("testKey")).to.equal("testValue");
    });

    it("should remove values from storage", () => {
      const storage = storageManager.getStorage("memoryStorage");
      storage.set("testKey", "testValue");
      expect(storage.get("testKey")).to.equal("testValue");
      storage.remove("testKey");
      expect(storage.get("testKey")).to.be.null;
    });
  });
});
