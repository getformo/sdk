import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import { JSDOM } from "jsdom";
import { EventManager } from "../../../src/lib/event/EventManager";
import { IEventQueue } from "../../../src/lib/queue";
import { APIEvent } from "../../../src/types";
import { initStorageManager } from "../../../src/lib/storage";

describe("EventManager", () => {
  let jsdom: JSDOM;
  let eventManager: EventManager;
  let mockEventQueue: IEventQueue;
  let enqueueSpy: sinon.SinonSpy;

  beforeEach(() => {
    jsdom = new JSDOM("<!DOCTYPE html><html><head><title>Test</title></head><body></body></html>", {
      url: "https://example.com/test?foo=bar",
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
    Object.defineProperty(global, "location", {
      value: jsdom.window.location,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(global, "globalThis", {
      value: jsdom.window,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(global, "navigator", {
      value: jsdom.window.navigator,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(global, "screen", {
      value: jsdom.window.screen,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(global, "devicePixelRatio", {
      value: 1,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(global, "innerWidth", {
      value: 1920,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(global, "innerHeight", {
      value: 1080,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(global, "Intl", {
      value: {
        DateTimeFormat: () => ({
          resolvedOptions: () => ({ timeZone: "America/New_York" }),
        }),
      },
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
    Object.defineProperty(global, "crypto", {
      value: {
        randomUUID: () => "mock-uuid-1234-5678-9abc-def012345678",
      },
      writable: true,
      configurable: true,
    });

    // Initialize StorageManager
    initStorageManager("test-write-key");

    // Create mock event queue
    enqueueSpy = sinon.spy();
    mockEventQueue = {
      enqueue: enqueueSpy,
      flush: sinon.stub().resolves(),
    };

    eventManager = new EventManager(mockEventQueue);
  });

  afterEach(() => {
    sinon.restore();
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
    if (jsdom) {
      jsdom.window.close();
    }
  });

  describe("addEvent", () => {
    it("should create and enqueue a page event", async () => {
      const apiEvent: APIEvent = {
        type: "page",
        properties: { customProp: "value" },
      };

      await eventManager.addEvent(apiEvent);

      expect(enqueueSpy.calledOnce).to.be.true;
      const [formoEvent] = enqueueSpy.firstCall.args;
      expect(formoEvent.type).to.equal("page");
    });

    it("should create and enqueue a track event", async () => {
      const apiEvent: APIEvent = {
        type: "track",
        event: "button_click",
        properties: { action: "click" },
      };

      await eventManager.addEvent(apiEvent);

      expect(enqueueSpy.calledOnce).to.be.true;
      const [formoEvent] = enqueueSpy.firstCall.args;
      expect(formoEvent.type).to.equal("track");
    });

    it("should include address when provided", async () => {
      const address = "0x1234567890123456789012345678901234567890";
      const apiEvent: APIEvent = {
        type: "connect",
        chainId: 1,
        address,
        properties: {},
      };

      await eventManager.addEvent(apiEvent, address);

      expect(enqueueSpy.calledOnce).to.be.true;
      const [formoEvent] = enqueueSpy.firstCall.args;
      expect(formoEvent.address).to.not.be.null;
    });

    it("should include userId when provided", async () => {
      const apiEvent: APIEvent = {
        type: "identify",
        address: "0x1234567890123456789012345678901234567890",
        providerName: "MetaMask",
        rdns: "io.metamask",
        properties: {},
      };
      const userId = "user-123";

      await eventManager.addEvent(apiEvent, undefined, userId);

      expect(enqueueSpy.calledOnce).to.be.true;
      const [formoEvent] = enqueueSpy.firstCall.args;
      expect(formoEvent.user_id).to.equal("user-123");
    });

    it("should block events from zero address", async () => {
      const zeroAddress = "0x0000000000000000000000000000000000000000";
      const apiEvent: APIEvent = {
        type: "connect",
        chainId: 1,
        address: zeroAddress,
        properties: {},
      };

      await eventManager.addEvent(apiEvent, zeroAddress);

      expect(enqueueSpy.called).to.be.false;
    });

    it("should block events from dead address", async () => {
      const deadAddress = "0x000000000000000000000000000000000000dEaD";
      const apiEvent: APIEvent = {
        type: "connect",
        chainId: 1,
        address: deadAddress,
        properties: {},
      };

      await eventManager.addEvent(apiEvent, deadAddress);

      expect(enqueueSpy.called).to.be.false;
    });

    it("should pass callback to event queue", async () => {
      const callback = sinon.spy();
      const apiEvent: APIEvent = {
        type: "page",
        properties: {},
        callback,
      };

      await eventManager.addEvent(apiEvent);

      expect(enqueueSpy.calledOnce).to.be.true;
      const [, enqueuedCallback] = enqueueSpy.firstCall.args;

      // Simulate callback being called
      enqueuedCallback(null, {}, [{}]);
      // The callback from apiEvent should not be called directly
      // It's wrapped by the EventManager
    });

    it("should handle events without properties", async () => {
      const apiEvent: APIEvent = {
        type: "page",
      };

      await eventManager.addEvent(apiEvent);

      expect(enqueueSpy.calledOnce).to.be.true;
    });
  });

  describe("event types", () => {
    it("should handle page event type", async () => {
      const apiEvent: APIEvent = { type: "page" };
      await eventManager.addEvent(apiEvent);
      expect(enqueueSpy.calledOnce).to.be.true;
      expect(enqueueSpy.firstCall.args[0].type).to.equal("page");
    });

    it("should handle identify event type", async () => {
      const apiEvent: APIEvent = {
        type: "identify",
        address: "0x1234567890123456789012345678901234567890",
        providerName: "MetaMask",
        rdns: "io.metamask",
      };
      await eventManager.addEvent(apiEvent);
      expect(enqueueSpy.calledOnce).to.be.true;
      expect(enqueueSpy.firstCall.args[0].type).to.equal("identify");
    });

    it("should handle detect event type", async () => {
      const apiEvent: APIEvent = {
        type: "detect",
        providerName: "MetaMask",
        rdns: "io.metamask",
      };
      await eventManager.addEvent(apiEvent);
      expect(enqueueSpy.calledOnce).to.be.true;
      expect(enqueueSpy.firstCall.args[0].type).to.equal("detect");
    });

    it("should handle connect event type", async () => {
      const apiEvent: APIEvent = {
        type: "connect",
        chainId: 1,
        address: "0x1234567890123456789012345678901234567890",
      };
      await eventManager.addEvent(apiEvent);
      expect(enqueueSpy.calledOnce).to.be.true;
      expect(enqueueSpy.firstCall.args[0].type).to.equal("connect");
    });

    it("should handle disconnect event type", async () => {
      const apiEvent: APIEvent = { type: "disconnect" };
      await eventManager.addEvent(apiEvent);
      expect(enqueueSpy.calledOnce).to.be.true;
      expect(enqueueSpy.firstCall.args[0].type).to.equal("disconnect");
    });

    it("should handle chain event type", async () => {
      const apiEvent: APIEvent = {
        type: "chain",
        chainId: 1,
        address: "0x1234567890123456789012345678901234567890",
      };
      await eventManager.addEvent(apiEvent);
      expect(enqueueSpy.calledOnce).to.be.true;
      expect(enqueueSpy.firstCall.args[0].type).to.equal("chain");
    });

    it("should handle track event type", async () => {
      const apiEvent: APIEvent = {
        type: "track",
        event: "button_click",
      };
      await eventManager.addEvent(apiEvent);
      expect(enqueueSpy.calledOnce).to.be.true;
      expect(enqueueSpy.firstCall.args[0].type).to.equal("track");
    });
  });

  describe("address validation", () => {
    it("should allow valid addresses", async () => {
      const validAddresses = [
        "0x1234567890123456789012345678901234567890",
        "0xabcdef1234567890abcdef1234567890abcdef12",
        "0xABCDEF1234567890ABCDEF1234567890ABCDEF12",
      ];

      for (const address of validAddresses) {
        enqueueSpy.resetHistory();
        const apiEvent: APIEvent = {
          type: "connect",
          chainId: 1,
          address,
        };

        await eventManager.addEvent(apiEvent, address);
        expect(enqueueSpy.calledOnce).to.be.true;
      }
    });

    it("should block blocked addresses case-insensitively", async () => {
      const blockedAddresses = [
        "0x0000000000000000000000000000000000000000",
        "0x000000000000000000000000000000000000dead",
        "0x000000000000000000000000000000000000DEAD",
        "0x000000000000000000000000000000000000dEaD",
      ];

      for (const address of blockedAddresses) {
        enqueueSpy.resetHistory();
        const apiEvent: APIEvent = {
          type: "connect",
          chainId: 1,
          address,
        };

        await eventManager.addEvent(apiEvent, address);
        expect(enqueueSpy.called).to.be.false;
      }
    });
  });
});
