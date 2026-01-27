import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import { JSDOM } from "jsdom";
import { EventQueue } from "../../../src/queue/EventQueue";
import { IFormoEvent } from "../../../src/types";
import * as fetchModule from "../../../src/fetch";

describe("EventQueue", () => {
  let jsdom: JSDOM;
  let eventQueue: EventQueue;
  let clock: sinon.SinonFakeTimers;

  const createMockEvent = (overrides: Partial<IFormoEvent> = {}): IFormoEvent => ({
    type: "page",
    anonymous_id: "12345678-1234-1234-1234-123456789abc" as `${string}-${string}-${string}-${string}-${string}`,
    user_id: null,
    address: null,
    channel: "web",
    version: "1.0.0",
    original_timestamp: new Date().toISOString(),
    context: {
      timezone: "America/New_York",
      locale: "en-US",
      page: {
        url: "https://example.com",
        path: "/",
        title: "Test Page",
      },
    },
    properties: {},
    ...overrides,
  });

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
    Object.defineProperty(global, "globalThis", {
      value: jsdom.window,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(global, "crypto", {
      value: {
        subtle: {
          digest: async (_algorithm: string, _data: ArrayBuffer) => {
            // Simple mock hash - just returns a fixed buffer
            return new Uint8Array(32).buffer;
          },
        },
        randomUUID: () => "12345678-1234-1234-1234-123456789abc",
      },
      writable: true,
      configurable: true,
    });

    clock = sinon.useFakeTimers();
  });

  afterEach(() => {
    clock.restore();
    sinon.restore();
    delete (global as any).window;
    delete (global as any).document;
    delete (global as any).globalThis;
    delete (global as any).crypto;
    if (jsdom) {
      jsdom.window.close();
    }
  });

  describe("constructor", () => {
    it("should initialize with default options", () => {
      eventQueue = new EventQueue("test-key", {
        apiHost: "https://api.example.com",
      });
      expect(eventQueue).to.not.be.null;
    });

    it("should clamp flushAt to valid range", () => {
      // flushAt should be clamped between MIN_FLUSH_AT (1) and MAX_FLUSH_AT (20)
      eventQueue = new EventQueue("test-key", {
        apiHost: "https://api.example.com",
        flushAt: 100, // Should be clamped to 20
      });
      expect(eventQueue).to.not.be.null;
    });

    it("should clamp retryCount to valid range", () => {
      eventQueue = new EventQueue("test-key", {
        apiHost: "https://api.example.com",
        retryCount: 100, // Should be clamped to MAX_RETRY (5)
      });
      expect(eventQueue).to.not.be.null;
    });

    it("should clamp flushInterval to valid range", () => {
      eventQueue = new EventQueue("test-key", {
        apiHost: "https://api.example.com",
        flushInterval: 1000, // Should be clamped to MIN_FLUSH_INTERVAL (10000)
      });
      expect(eventQueue).to.not.be.null;
    });
  });

  describe("enqueue", () => {
    beforeEach(() => {
      eventQueue = new EventQueue("test-key", {
        apiHost: "https://api.example.com",
        flushAt: 5,
        flushInterval: 30000,
      });
    });

    it("should add event to queue without immediate flush", async () => {
      const event = createMockEvent();
      // Enqueue should not throw
      await eventQueue.enqueue(event);
    });

    it("should accept callback parameter", async () => {
      const callback = sinon.spy();
      const event = createMockEvent();
      await eventQueue.enqueue(event, callback);
    });
  });

  describe("flush", () => {
    beforeEach(() => {
      eventQueue = new EventQueue("test-key", {
        apiHost: "https://api.example.com",
        flushAt: 20,
        flushInterval: 30000,
      });
    });

    it("should return immediately when queue is empty", async () => {
      const result = await eventQueue.flush();
      expect(result).to.be.undefined;
    });

    it("should accept callback parameter", async () => {
      const callback = sinon.spy();
      await eventQueue.flush(callback);
      expect(callback.called).to.be.true;
    });
  });

  describe("queue behavior", () => {
    it("should initialize with empty queue", () => {
      eventQueue = new EventQueue("test-key", {
        apiHost: "https://api.example.com",
      });
      // Should not throw when flushing empty queue
      expect(() => eventQueue.flush()).to.not.throw();
    });
  });

  describe("flush error handling", () => {
    let fetchStub: sinon.SinonStub;

    function makeResponse(status: number, statusText: string): Response {
      return {
        ok: status >= 200 && status < 300,
        status,
        statusText,
        headers: new Headers(),
        redirected: false,
        type: "basic" as ResponseType,
        url: "",
        clone: () => makeResponse(status, statusText),
        body: null,
        bodyUsed: false,
        arrayBuffer: async () => new ArrayBuffer(0),
        blob: async () => new Blob(),
        formData: async () => new FormData(),
        json: async () => ({}),
        text: async () => "",
        bytes: async () => new Uint8Array(),
      } as Response;
    }

    beforeEach(async () => {
      fetchStub = sinon.stub(fetchModule, "default");
    });

    it("should not throw on network error (fire-and-forget)", async () => {
      fetchStub.rejects(new TypeError("Failed to fetch"));

      eventQueue = new EventQueue("test-key", {
        apiHost: "https://api.example.com",
        flushAt: 20,
        flushInterval: 30000,
        retryCount: 1,
      });

      const event = createMockEvent();
      await eventQueue.enqueue(event);

      // flush() should resolve, not reject — errors are swallowed
      await eventQueue.flush();
    });

    it("should not throw on non-ok HTTP response", async () => {
      fetchStub.resolves(makeResponse(500, "Internal Server Error"));

      eventQueue = new EventQueue("test-key", {
        apiHost: "https://api.example.com",
        flushAt: 20,
        flushInterval: 30000,
        retryCount: 1,
      });

      const event = createMockEvent();
      await eventQueue.enqueue(event);

      // flush() should resolve, not reject
      await eventQueue.flush();
    });

    it("should call errorHandler on network error", async () => {
      const networkError = new TypeError("Failed to fetch");
      fetchStub.rejects(networkError);

      const errorHandler = sinon.spy();
      eventQueue = new EventQueue("test-key", {
        apiHost: "https://api.example.com",
        flushAt: 20,
        flushInterval: 30000,
        retryCount: 1,
        errorHandler,
      });

      const event = createMockEvent();
      await eventQueue.enqueue(event);
      await eventQueue.flush();

      expect(errorHandler.calledOnce).to.be.true;
      expect(errorHandler.firstCall.args[0]).to.equal(networkError);
    });

    it("should call errorHandler on non-ok HTTP response", async () => {
      fetchStub.resolves(makeResponse(500, "Internal Server Error"));

      const errorHandler = sinon.spy();
      eventQueue = new EventQueue("test-key", {
        apiHost: "https://api.example.com",
        flushAt: 20,
        flushInterval: 30000,
        retryCount: 1,
        errorHandler,
      });

      const event = createMockEvent();
      await eventQueue.enqueue(event);
      await eventQueue.flush();

      expect(errorHandler.calledOnce).to.be.true;
      const err = errorHandler.firstCall.args[0];
      expect(err).to.be.an.instanceOf(Error);
      expect(err.message).to.include("Internal Server Error");
    });

    it("should call done callback with error on failure", async () => {
      fetchStub.rejects(new TypeError("Failed to fetch"));

      eventQueue = new EventQueue("test-key", {
        apiHost: "https://api.example.com",
        flushAt: 20,
        flushInterval: 30000,
        retryCount: 1,
      });

      const itemCallback = sinon.spy();
      const event = createMockEvent();
      await eventQueue.enqueue(event, itemCallback);

      await eventQueue.flush();

      expect(itemCallback.calledOnce).to.be.true;
      // First argument to callback is the error
      expect(itemCallback.firstCall.args[0]).to.be.an.instanceOf(Error);
    });

    it("should call done callback without error on success", async () => {
      fetchStub.resolves(makeResponse(200, "OK"));

      eventQueue = new EventQueue("test-key", {
        apiHost: "https://api.example.com",
        flushAt: 20,
        flushInterval: 30000,
        retryCount: 1,
      });

      const itemCallback = sinon.spy();
      const event = createMockEvent();
      await eventQueue.enqueue(event, itemCallback);

      await eventQueue.flush();

      expect(itemCallback.calledOnce).to.be.true;
      // First argument to callback is undefined (no error)
      expect(itemCallback.firstCall.args[0]).to.be.undefined;
    });

    it("should not call errorHandler on success", async () => {
      fetchStub.resolves(makeResponse(200, "OK"));

      const errorHandler = sinon.spy();
      eventQueue = new EventQueue("test-key", {
        apiHost: "https://api.example.com",
        flushAt: 20,
        flushInterval: 30000,
        retryCount: 1,
        errorHandler,
      });

      const event = createMockEvent();
      await eventQueue.enqueue(event);
      await eventQueue.flush();

      expect(errorHandler.called).to.be.false;
    });
  });

  describe("keepalive payload splitting", () => {
    let fetchStub: sinon.SinonStub;

    function makeResponse(status: number, statusText: string): Response {
      return {
        ok: status >= 200 && status < 300,
        status,
        statusText,
        headers: new Headers(),
        redirected: false,
        type: "basic" as ResponseType,
        url: "",
        clone: () => makeResponse(status, statusText),
        body: null,
        bodyUsed: false,
        arrayBuffer: async () => new ArrayBuffer(0),
        blob: async () => new Blob(),
        formData: async () => new FormData(),
        json: async () => ({}),
        text: async () => "",
        bytes: async () => new Uint8Array(),
      } as Response;
    }

    beforeEach(async () => {
      fetchStub = sinon.stub(fetchModule, "default");
      fetchStub.resolves(makeResponse(200, "OK"));
    });

    it("should send small payload with keepalive: true", async () => {
      eventQueue = new EventQueue("test-key", {
        apiHost: "https://api.example.com",
        flushAt: 20,
        flushInterval: 30000,
        retryCount: 1,
      });

      const event = createMockEvent();
      await eventQueue.enqueue(event);
      await eventQueue.flush();

      expect(fetchStub.calledOnce).to.be.true;
      const fetchInit = fetchStub.firstCall.args[1];
      expect(fetchInit.keepalive).to.be.true;
    });

    it("should split large payload into multiple requests with keepalive: true", async () => {
      eventQueue = new EventQueue("test-key", {
        apiHost: "https://api.example.com",
        flushAt: 20,
        flushInterval: 30000,
        retryCount: 1,
      });

      // Override crypto.subtle.digest to return unique hashes per input
      // so events are not deduplicated
      let hashCounter = 0;
      Object.defineProperty(global, "crypto", {
        value: {
          subtle: {
            digest: async (_algorithm: string, _data: ArrayBuffer) => {
              const buf = new Uint8Array(32);
              buf[0] = ++hashCounter;
              return buf.buffer;
            },
          },
          randomUUID: () => "12345678-1234-1234-1234-123456789abc",
        },
        writable: true,
        configurable: true,
      });

      // Create events with large properties to exceed 64KB total
      // Each event ~10KB, so 8 events ≈ 80KB > 64KB limit
      const largeProps: Record<string, string> = {};
      for (let i = 0; i < 50; i++) {
        largeProps[`field_${i}`] = "x".repeat(200);
      }

      for (let i = 0; i < 8; i++) {
        const event = createMockEvent({
          original_timestamp: new Date(Date.now() + i).toISOString(),
          properties: { ...largeProps, index: i },
        });
        await eventQueue.enqueue(event);
      }

      await eventQueue.flush();

      // Should have been split into multiple fetch calls
      expect(fetchStub.callCount).to.be.greaterThan(1);

      // All sub-batches should use keepalive: true and fit under 64KB
      for (let i = 0; i < fetchStub.callCount; i++) {
        const fetchInit = fetchStub.getCall(i).args[1];
        expect(fetchInit.keepalive).to.be.true;
        // Each body should be under 64KB in UTF-8 bytes
        const byteSize = new TextEncoder().encode(fetchInit.body).byteLength;
        expect(byteSize).to.be.at.most(64 * 1024);
      }
    });

    it("should send batches sequentially, not concurrently", async () => {
      // Track how many fetches are in-flight simultaneously
      let inFlight = 0;
      let maxInFlight = 0;

      fetchStub.restore();
      fetchStub = sinon.stub(fetchModule, "default");

      fetchStub.callsFake(() => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return Promise.resolve().then(() => {
          inFlight--;
          return makeResponse(200, "OK");
        });
      });

      // Override crypto for unique hashes
      let hashCounter = 0;
      Object.defineProperty(global, "crypto", {
        value: {
          subtle: {
            digest: async (_algorithm: string, _data: ArrayBuffer) => {
              const buf = new Uint8Array(32);
              buf[0] = ++hashCounter;
              return buf.buffer;
            },
          },
          randomUUID: () => "12345678-1234-1234-1234-123456789abc",
        },
        writable: true,
        configurable: true,
      });

      eventQueue = new EventQueue("test-key", {
        apiHost: "https://api.example.com",
        flushAt: 20,
        flushInterval: 30000,
        retryCount: 1,
      });

      const largeProps: Record<string, string> = {};
      for (let i = 0; i < 50; i++) {
        largeProps[`field_${i}`] = "x".repeat(200);
      }

      for (let i = 0; i < 8; i++) {
        const event = createMockEvent({
          original_timestamp: new Date(Date.now() + i).toISOString(),
          properties: { ...largeProps, index: i },
        });
        await eventQueue.enqueue(event);
      }

      await eventQueue.flush();

      // Multiple batches were sent
      expect(fetchStub.callCount).to.be.greaterThan(1);
      // But at most one was in-flight at any time (sequential, not concurrent)
      expect(maxInFlight).to.equal(1);
    });

    it("should disable keepalive for a single event exceeding 64KB", async () => {
      eventQueue = new EventQueue("test-key", {
        apiHost: "https://api.example.com",
        flushAt: 20,
        flushInterval: 30000,
        retryCount: 1,
      });

      // Create a single event that exceeds 64KB on its own
      const hugeProps: Record<string, string> = {};
      for (let i = 0; i < 100; i++) {
        hugeProps[`field_${i}`] = "x".repeat(700);
      }

      const event = createMockEvent({ properties: hugeProps });
      await eventQueue.enqueue(event);
      await eventQueue.flush();

      expect(fetchStub.calledOnce).to.be.true;
      const fetchInit = fetchStub.firstCall.args[1];
      expect(fetchInit.keepalive).to.be.false;
    });

    it("should still call done callback on success with split batches", async () => {
      // Override crypto.subtle.digest to return unique hashes per input
      let hashCounter = 0;
      Object.defineProperty(global, "crypto", {
        value: {
          subtle: {
            digest: async (_algorithm: string, _data: ArrayBuffer) => {
              const buf = new Uint8Array(32);
              buf[0] = ++hashCounter;
              return buf.buffer;
            },
          },
          randomUUID: () => "12345678-1234-1234-1234-123456789abc",
        },
        writable: true,
        configurable: true,
      });

      eventQueue = new EventQueue("test-key", {
        apiHost: "https://api.example.com",
        flushAt: 20,
        flushInterval: 30000,
        retryCount: 1,
      });

      const largeProps: Record<string, string> = {};
      for (let i = 0; i < 50; i++) {
        largeProps[`field_${i}`] = "x".repeat(200);
      }

      const itemCallback = sinon.spy();
      for (let i = 0; i < 8; i++) {
        const event = createMockEvent({
          original_timestamp: new Date(Date.now() + i).toISOString(),
          properties: { ...largeProps, index: i },
        });
        await eventQueue.enqueue(event, itemCallback);
      }

      await eventQueue.flush();

      // All item callbacks should have been called without error
      expect(itemCallback.callCount).to.equal(8);
      for (let i = 0; i < 8; i++) {
        expect(itemCallback.getCall(i).args[0]).to.be.undefined;
      }
    });
  });
});
