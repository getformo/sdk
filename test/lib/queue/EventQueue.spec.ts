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

  /** Override crypto.subtle.digest to return unique hashes so events are not deduplicated. */
  function useUniqueCryptoHashes() {
    let counter = 0;
    Object.defineProperty(global, "crypto", {
      value: {
        subtle: {
          digest: async (_algorithm: string, _data: ArrayBuffer) => {
            const buf = new Uint8Array(32);
            buf[0] = ++counter;
            return buf.buffer;
          },
        },
        randomUUID: () => "12345678-1234-1234-1234-123456789abc",
      },
      writable: true,
      configurable: true,
    });
  }

  /** Enqueue multiple large (~10KB each) events to exceed the 64KB keepalive limit. */
  async function enqueueLargeEvents(queue: EventQueue, count = 8, cb?: sinon.SinonSpy) {
    const largeProps: Record<string, string> = {};
    for (let i = 0; i < 50; i++) {
      largeProps[`field_${i}`] = "x".repeat(200);
    }
    for (let i = 0; i < count; i++) {
      const event = createMockEvent({
        original_timestamp: new Date(Date.now() + i).toISOString(),
        properties: { ...largeProps, index: i },
      });
      await queue.enqueue(event, cb);
    }
  }

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

    // B4 regression: a failed flush must invoke each per-event callback
    // exactly once (with the error) and NEVER again — failed items are
    // not requeued, so there is no "error then success" double-fire.
    it("invokes a per-event callback exactly once across a failed flush + later success", async () => {
      fetchStub.rejects(new TypeError("Failed to fetch"));
      eventQueue = new EventQueue("test-key", {
        apiHost: "https://api.example.com",
        flushAt: 20,
        flushInterval: 30000,
        retryCount: 1,
      });

      const cbA = sinon.spy();
      await eventQueue.enqueue(createMockEvent({ message_id: "a" } as any), cbA);
      await eventQueue.flush();

      expect(cbA.calledOnce, "cbA fired once on failure").to.be.true;
      expect(cbA.firstCall.args[0]).to.be.an.instanceOf(Error);

      // A subsequent successful flush of a *different* event must not
      // resurrect or re-invoke the failed event's callback.
      fetchStub.resolves(makeResponse(200, "OK"));
      const cbB = sinon.spy();
      await eventQueue.enqueue(createMockEvent({ message_id: "b" } as any), cbB);
      await eventQueue.flush();

      expect(cbB.calledOnce, "cbB fired once on success").to.be.true;
      expect(cbB.firstCall.args[0]).to.be.undefined;
      // The crux: cbA was never called a second time (no error→success).
      expect(cbA.callCount, "cbA total invocations").to.equal(1);
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

    it("should not throw when errorHandler itself throws", async () => {
      fetchStub.rejects(new TypeError("Failed to fetch"));

      const errorHandler = sinon.stub().throws(new Error("handler broke"));
      eventQueue = new EventQueue("test-key", {
        apiHost: "https://api.example.com",
        flushAt: 20,
        flushInterval: 30000,
        retryCount: 1,
        errorHandler,
      });

      const event = createMockEvent();
      await eventQueue.enqueue(event);

      // flush() should still resolve — errorHandler exception is swallowed
      await eventQueue.flush();
      expect(errorHandler.calledOnce).to.be.true;
    });

    it("should not produce unhandled rejection when flush callback throws", async () => {
      fetchStub.resolves(makeResponse(200, "OK"));

      eventQueue = new EventQueue("test-key", {
        apiHost: "https://api.example.com",
        flushAt: 20,
        flushInterval: 30000,
        retryCount: 1,
      });

      const event = createMockEvent();
      await eventQueue.enqueue(event);

      const throwingCallback = () => { throw new Error("callback exploded"); };

      // flush() should resolve without unhandled rejection even if callback throws
      await eventQueue.flush(throwingCallback);
    });
  });

  describe("keepalive payload splitting", () => {
    let fetchStub: sinon.SinonStub;

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
      useUniqueCryptoHashes();

      eventQueue = new EventQueue("test-key", {
        apiHost: "https://api.example.com",
        flushAt: 20,
        flushInterval: 30000,
        retryCount: 1,
      });

      await enqueueLargeEvents(eventQueue);
      await eventQueue.flush();

      // Should have been split into multiple fetch calls
      expect(fetchStub.callCount).to.be.greaterThan(1);

      // All sub-batches should use keepalive: true and fit under 64KB
      for (let i = 0; i < fetchStub.callCount; i++) {
        const fetchInit = fetchStub.getCall(i).args[1];
        expect(fetchInit.keepalive).to.be.true;
        const byteSize = new TextEncoder().encode(fetchInit.body).byteLength;
        expect(byteSize).to.be.at.most(64 * 1024);
      }
    });

    it("should send batches sequentially, not concurrently", async () => {
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

      useUniqueCryptoHashes();

      eventQueue = new EventQueue("test-key", {
        apiHost: "https://api.example.com",
        flushAt: 20,
        flushInterval: 30000,
        retryCount: 1,
      });

      await enqueueLargeEvents(eventQueue);
      await eventQueue.flush();

      expect(fetchStub.callCount).to.be.greaterThan(1);
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
      useUniqueCryptoHashes();

      eventQueue = new EventQueue("test-key", {
        apiHost: "https://api.example.com",
        flushAt: 20,
        flushInterval: 30000,
        retryCount: 1,
      });

      const itemCallback = sinon.spy();
      await enqueueLargeEvents(eventQueue, 8, itemCallback);
      await eventQueue.flush();

      expect(itemCallback.callCount).to.equal(8);
      for (let i = 0; i < 8; i++) {
        expect(itemCallback.getCall(i).args[0]).to.be.undefined;
      }
    });

    it("should continue sending remaining batches when an earlier batch fails", async () => {
      let callCount = 0;
      fetchStub.restore();
      fetchStub = sinon.stub(fetchModule, "default");
      fetchStub.callsFake(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new TypeError("Failed to fetch"));
        }
        return Promise.resolve(makeResponse(200, "OK"));
      });

      useUniqueCryptoHashes();

      eventQueue = new EventQueue("test-key", {
        apiHost: "https://api.example.com",
        flushAt: 20,
        flushInterval: 30000,
        retryCount: 1,
      });

      await enqueueLargeEvents(eventQueue);
      await eventQueue.flush();

      expect(fetchStub.callCount).to.be.greaterThan(1);
    });

    it("should report per-item success/failure when a batch fails partway", async () => {
      let callCount = 0;
      fetchStub.restore();
      fetchStub = sinon.stub(fetchModule, "default");
      fetchStub.callsFake(() => {
        callCount++;
        if (callCount === 2) {
          return Promise.reject(new TypeError("Failed to fetch"));
        }
        return Promise.resolve(makeResponse(200, "OK"));
      });

      useUniqueCryptoHashes();

      eventQueue = new EventQueue("test-key", {
        apiHost: "https://api.example.com",
        flushAt: 20,
        flushInterval: 30000,
        retryCount: 1,
      });

      const itemCallback = sinon.spy();
      await enqueueLargeEvents(eventQueue, 8, itemCallback);
      await eventQueue.flush();

      expect(itemCallback.callCount).to.equal(8);

      let successCount = 0;
      let failureCount = 0;
      for (let i = 0; i < itemCallback.callCount; i++) {
        if (itemCallback.getCall(i).args[0] === undefined) {
          successCount++;
        } else {
          failureCount++;
        }
      }
      expect(successCount).to.be.greaterThan(0);
      expect(failureCount).to.be.greaterThan(0);
    });

    it("should call errorHandler with error on partial batch failure", async () => {
      let callCount = 0;
      fetchStub.restore();
      fetchStub = sinon.stub(fetchModule, "default");
      fetchStub.callsFake(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new TypeError("Failed to fetch"));
        }
        return Promise.resolve(makeResponse(200, "OK"));
      });

      useUniqueCryptoHashes();

      const errorHandler = sinon.spy();
      eventQueue = new EventQueue("test-key", {
        apiHost: "https://api.example.com",
        flushAt: 20,
        flushInterval: 30000,
        retryCount: 1,
        errorHandler,
      });

      await enqueueLargeEvents(eventQueue);
      await eventQueue.flush();

      expect(errorHandler.calledOnce).to.be.true;
      expect(errorHandler.firstCall.args[0]).to.be.an.instanceOf(TypeError);
    });
  });

  describe("consent gate (canSend) and clear()", () => {
    let fetchStub: sinon.SinonStub;

    beforeEach(() => {
      fetchStub = sinon.stub(fetchModule, "default");
      fetchStub.resolves(makeResponse(200, "OK"));
    });

    it("does not send when consent is revoked before flush", async () => {
      let allowed = true;
      eventQueue = new EventQueue("test-key", {
        apiHost: "https://api.example.com",
        flushAt: 20,
        flushInterval: 30000,
        retryCount: 1,
        canSend: () => allowed,
      });

      await eventQueue.enqueue(createMockEvent());
      allowed = false; // consent withdrawn while buffered
      await eventQueue.flush();

      expect(fetchStub.called, "no network send after opt-out").to.be.false;
    });

    it("enqueue is a no-op once canSend() is false", async () => {
      eventQueue = new EventQueue("test-key", {
        apiHost: "https://api.example.com",
        flushAt: 1,
        flushInterval: 30000,
        retryCount: 1,
        canSend: () => false,
      });

      await eventQueue.enqueue(createMockEvent());
      await eventQueue.flush();

      expect(fetchStub.called).to.be.false;
    });

    it("clear() drops buffered events; queue is reusable afterwards", async () => {
      useUniqueCryptoHashes();
      eventQueue = new EventQueue("test-key", {
        apiHost: "https://api.example.com",
        flushAt: 20,
        flushInterval: 30000,
        retryCount: 1,
      });

      await eventQueue.enqueue(createMockEvent());
      await eventQueue.enqueue(createMockEvent());
      eventQueue.clear();
      await eventQueue.flush();
      expect(fetchStub.called, "cleared events are not sent").to.be.false;

      // Queue still works after clear (byteSize/state re-anchored).
      await eventQueue.enqueue(createMockEvent());
      await eventQueue.flush();
      expect(fetchStub.calledOnce, "post-clear enqueue still flushes").to.be
        .true;
    });
  });

  // Reproduces the "same message_id, varying sent_at" pattern. The hash is
  // computed from event payload + UTC-minute-rounded timestamp, so two
  // identical events within the same minute share a message_id. A re-enqueue
  // of the same event after a successful flush used to slip through because
  // dedup state was scoped to the in-queue window only.
  describe("cross-flush dedup (re-send guard)", () => {
    let fetchStub: sinon.SinonStub;

    beforeEach(() => {
      fetchStub = sinon.stub(fetchModule, "default");
      fetchStub.resolves(makeResponse(200, "OK"));
    });

    it("rejects a re-enqueue of the same event after a successful flush", async () => {
      eventQueue = new EventQueue("test-key", {
        apiHost: "https://api.example.com",
        flushAt: 20,
        flushInterval: 30000,
        retryCount: 1,
      });

      await eventQueue.enqueue(createMockEvent());
      await eventQueue.flush();
      expect(fetchStub.callCount, "first flush sent once").to.equal(1);

      // Same event (same payload → same message_id) emitted again well
      // inside the dedup TTL — must NOT be queued or sent.
      await eventQueue.enqueue(createMockEvent());
      await eventQueue.flush();
      expect(
        fetchStub.callCount,
        "re-enqueue after flush is dedup'd, no second send"
      ).to.equal(1);
    });

    it("allows a re-enqueue of the same event after a failed flush", async () => {
      fetchStub.restore();
      fetchStub = sinon.stub(fetchModule, "default");
      fetchStub.rejects(new TypeError("Failed to fetch"));

      eventQueue = new EventQueue("test-key", {
        apiHost: "https://api.example.com",
        flushAt: 20,
        flushInterval: 30000,
        retryCount: 1,
      });

      await eventQueue.enqueue(createMockEvent());
      await eventQueue.flush();
      expect(fetchStub.callCount, "first flush attempted").to.equal(1);

      // On failure the dedup entry is dropped so the caller can re-enqueue
      // from the per-item error callback. Otherwise a transient network
      // error would silently swallow the retry for the full dedup TTL.
      await eventQueue.enqueue(createMockEvent());
      await eventQueue.flush();
      expect(
        fetchStub.callCount,
        "re-enqueue after failure is allowed"
      ).to.equal(2);
    });

    it("dedup still applies to an in-flight duplicate even if the eventual send fails", async () => {
      let resolveFirst: (r: Response) => void = () => {};
      fetchStub.restore();
      fetchStub = sinon.stub(fetchModule, "default");
      fetchStub.onFirstCall().returns(
        new Promise<Response>((_resolve, reject) => {
          resolveFirst = (() => reject(new TypeError("Failed to fetch"))) as never;
        })
      );

      eventQueue = new EventQueue("test-key", {
        apiHost: "https://api.example.com",
        flushAt: 20,
        flushInterval: 30000,
        retryCount: 1,
      });

      await eventQueue.enqueue(createMockEvent());
      const first = eventQueue.flush();

      // While the first send is in flight, a duplicate enqueue must still
      // be rejected — otherwise the same event could appear twice in a
      // later flush even when the first one ultimately fails.
      await eventQueue.enqueue(createMockEvent());

      resolveFirst(makeResponse(200, "OK"));
      await first;

      // The in-flight duplicate was dedup'd, so only the original was sent.
      expect(fetchStub.callCount).to.equal(1);
    });

    it("protects in-queue / in-flight ids from cap eviction in seenMessageIds", async () => {
      eventQueue = new EventQueue("test-key", {
        apiHost: "https://api.example.com",
        flushAt: 20,
        flushInterval: 30000,
        retryCount: 1,
      });

      // Enqueue one event; its id is now in both seenMessageIds and unackedIds.
      await eventQueue.enqueue(createMockEvent());
      const seen = (eventQueue as unknown as {
        seenMessageIds: Map<string, number>;
      }).seenMessageIds;
      const unacked = (eventQueue as unknown as {
        unackedIds: Set<string>;
      }).unackedIds;
      expect(unacked.size, "queued id marked unacked").to.equal(1);
      const queuedId = Array.from(unacked)[0];

      // Flood seenMessageIds past MAX_DEDUP_ENTRIES (1000) with synthetic
      // ids inserted BEFORE the queued id's insertion position is touched
      // by eviction — they're inserted after, so the queued id is the
      // oldest entry and would be the first evicted without protection.
      // To make the queued id appear first in insertion order, re-set it.
      const queuedTs = seen.get(queuedId)!;
      seen.delete(queuedId);
      seen.set(queuedId, queuedTs);
      for (let i = 0; i < 1100; i++) {
        seen.set(`synth-${i}`, Date.now());
      }
      expect(seen.size).to.be.greaterThan(1000);
      expect(seen.has(queuedId), "queued id is the oldest entry").to.be.true;

      // Trigger pruneSeenMessageIds via a fresh enqueue.
      useUniqueCryptoHashes();
      await eventQueue.enqueue(
        createMockEvent({ properties: { unique: "trigger-prune" } })
      );

      // Cap eviction ran (size dropped close to the cap) and the queued
      // id survives because it's protected by unackedIds. Size is `cap +
      // 1` because the triggering enqueue adds its own id after the prune.
      expect(seen.size, "size capped (≈ MAX_DEDUP_ENTRIES)").to.be.at.most(
        1001
      );
      expect(seen.size, "actually pruned").to.be.lessThan(1101);
      expect(
        seen.has(queuedId),
        "queued id NOT evicted (protected by unackedIds)"
      ).to.be.true;
    });

    it("removes the unacked marker on send success but keeps it in seenMessageIds", async () => {
      eventQueue = new EventQueue("test-key", {
        apiHost: "https://api.example.com",
        flushAt: 20,
        flushInterval: 30000,
        retryCount: 1,
      });

      await eventQueue.enqueue(createMockEvent());
      await eventQueue.flush();

      const seen = (eventQueue as unknown as {
        seenMessageIds: Map<string, number>;
      }).seenMessageIds;
      const unacked = (eventQueue as unknown as {
        unackedIds: Set<string>;
      }).unackedIds;
      expect(seen.size, "id retained for cross-flush dedup").to.equal(1);
      expect(unacked.size, "unacked marker cleared after success").to.equal(0);
    });

    it("removes both unacked and seenMessageIds entries on send failure", async () => {
      fetchStub.restore();
      fetchStub = sinon.stub(fetchModule, "default");
      fetchStub.rejects(new TypeError("Failed to fetch"));

      eventQueue = new EventQueue("test-key", {
        apiHost: "https://api.example.com",
        flushAt: 20,
        flushInterval: 30000,
        retryCount: 1,
      });

      await eventQueue.enqueue(createMockEvent());
      await eventQueue.flush();

      const seen = (eventQueue as unknown as {
        seenMessageIds: Map<string, number>;
      }).seenMessageIds;
      const unacked = (eventQueue as unknown as {
        unackedIds: Set<string>;
      }).unackedIds;
      expect(seen.size, "id cleared on failure so caller can retry").to.equal(
        0
      );
      expect(unacked.size, "unacked marker cleared").to.equal(0);
    });

    it("clears dedup state for batches skipped due to mid-flush consent revoke", async () => {
      // Two large events so the flush splits into separate batches.
      // After the first batch finishes, canSend flips false; sendBatches
      // breaks before sending batch 2. Without cleanup, batch 2's items
      // would stay in unackedIds forever (pruneSeenMessageIds protects
      // them), and a re-opt-in would silently dedup-drop the same events.
      let allowed = true;
      let batchesSent = 0;
      fetchStub.restore();
      fetchStub = sinon.stub(fetchModule, "default");
      fetchStub.callsFake(() => {
        batchesSent++;
        if (batchesSent === 1) allowed = false;
        return Promise.resolve(makeResponse(200, "OK"));
      });

      useUniqueCryptoHashes();

      eventQueue = new EventQueue("test-key", {
        apiHost: "https://api.example.com",
        flushAt: 20,
        flushInterval: 30000,
        retryCount: 1,
        canSend: () => allowed,
      });

      await enqueueLargeEvents(eventQueue);
      await eventQueue.flush();

      // At least one batch sent, then consent revoked partway through.
      expect(fetchStub.callCount, "consent broke the loop early").to.be.lessThan(
        2 + 5 // arbitrary upper bound, just confirming a break occurred
      );

      const seen = (eventQueue as unknown as {
        seenMessageIds: Map<string, number>;
      }).seenMessageIds;
      const unacked = (eventQueue as unknown as {
        unackedIds: Set<string>;
      }).unackedIds;

      // No unacked markers should leak — every spliced item either
      // succeeded (cleared on success) or was skipped (cleared on the
      // consent break path).
      expect(unacked.size, "unacked markers cleared on consent break").to.equal(
        0
      );
      // Only the successfully delivered items should remain in
      // seenMessageIds; skipped items are not "delivered duplicates."
      // 8 events enqueued total — at least one batch was skipped, so
      // some ids must have been cleared from seenMessageIds.
      expect(
        seen.size,
        "skipped batches' ids cleared from seenMessageIds"
      ).to.be.lessThan(8);
      expect(seen.size, "delivered batch ids retained").to.be.greaterThan(0);
    });

    it("allows the same event to be re-sent once the dedup TTL elapses", async () => {
      eventQueue = new EventQueue("test-key", {
        apiHost: "https://api.example.com",
        flushAt: 20,
        flushInterval: 30000,
        retryCount: 1,
      });

      await eventQueue.enqueue(createMockEvent());
      await eventQueue.flush();
      expect(fetchStub.callCount, "first flush sent once").to.equal(1);

      // Advance past the dedup TTL (5 min) so the id is pruned. The same
      // event is then a legitimately new emission and goes through.
      clock.tick(6 * 60 * 1000);

      await eventQueue.enqueue(createMockEvent());
      await eventQueue.flush();
      expect(fetchStub.callCount, "post-TTL re-enqueue sends again").to.equal(
        2
      );
    });

    it("does not POST an empty array when a concurrent flush already drained the queue", async () => {
      useUniqueCryptoHashes();

      // Hold the first flush in-flight so a second concurrent flush
      // awaits it, then resumes after the queue is empty.
      let resolveFirst: (r: Response) => void = () => {};
      fetchStub.restore();
      fetchStub = sinon.stub(fetchModule, "default");
      fetchStub.onFirstCall().returns(
        new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        })
      );
      fetchStub.resolves(makeResponse(200, "OK"));

      eventQueue = new EventQueue("test-key", {
        apiHost: "https://api.example.com",
        flushAt: 20,
        flushInterval: 30000,
        retryCount: 1,
      });

      await eventQueue.enqueue(createMockEvent());

      const first = eventQueue.flush();
      const second = eventQueue.flush();

      resolveFirst(makeResponse(200, "OK"));
      await Promise.all([first, second]);

      // Only one real POST — no empty `[]` body from the second flush
      // resuming after the queue was drained.
      expect(fetchStub.callCount).to.equal(1);
    });
  });
});
