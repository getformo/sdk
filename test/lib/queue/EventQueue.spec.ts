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
    let fetchStub: sinon.SinonStub;

    beforeEach(() => {
      fetchStub = sinon.stub(fetchModule, "default");
      fetchStub.resolves(makeResponse(200, "OK"));
      useUniqueCryptoHashes();
      eventQueue = new EventQueue("test-key", {
        apiHost: "https://api.example.com",
        flushAt: 5,
        flushInterval: 30000,
      });
    });

    // Ad-click landings in mobile in-app browsers are often killed before
    // any lifecycle flush fires; if the landing page event waits for the
    // batch timer it dies with the process. So the very first event must
    // reach the wire immediately, and only subsequent events may batch.
    it("should flush the first event immediately", async () => {
      await eventQueue.enqueue(createMockEvent());
      await (eventQueue as any).pendingFlush;

      expect(fetchStub.calledOnce).to.be.true;
      const body = JSON.parse(fetchStub.firstCall.args[1].body);
      expect(body).to.have.length(1);
    });

    it("should batch subsequent events instead of flushing each", async () => {
      await eventQueue.enqueue(createMockEvent());
      await (eventQueue as any).pendingFlush;
      // A distinct event: the dedup hash truncates timestamps to the
      // minute, so a same-minute copy would be dropped as a duplicate rather
      // than batched, and this test would pass for the wrong reason.
      await eventQueue.enqueue(createMockEvent({ properties: { n: 2 } }));
      await (eventQueue as any).pendingFlush;

      // Only the first event's immediate flush hit the network; the second
      // stays queued for the flushAt/interval/pagehide paths.
      expect(fetchStub.calledOnce).to.be.true;
      expect((eventQueue as any).queue).to.have.length(1);
    });

    // The dedup hash used to leave with its event at flush time. Once the
    // first event of a page load was sent the instant it arrived (#326),
    // its hash went with it, so a double-fired track() a moment later was
    // accepted instead of suppressed (#372). The hash now lives for the
    // full dedup window whatever the flush timing.
    describe("duplicate suppression", () => {
      it("drops an identical event sent right after the immediate first flush", async () => {
        const event = createMockEvent();
        await eventQueue.enqueue(event);
        await (eventQueue as any).pendingFlush;
        expect(fetchStub.calledOnce).to.be.true;

        await eventQueue.enqueue({ ...event });
        await (eventQueue as any).pendingFlush;

        expect(fetchStub.calledOnce, "no second send").to.be.true;
        expect((eventQueue as any).queue, "nothing left queued").to.have.length(0);
      });

      it("keeps suppressing after a later flush while the window is open", async () => {
        await eventQueue.enqueue(createMockEvent({ properties: { n: 1 } }));
        await (eventQueue as any).pendingFlush;

        const event = createMockEvent({ properties: { n: 2 } });
        await eventQueue.enqueue(event);
        await eventQueue.flush();
        expect(fetchStub.callCount).to.equal(2);

        clock.tick(30_000);
        await eventQueue.enqueue({ ...event });
        expect((eventQueue as any).queue).to.have.length(0);
      });

      it("accepts an identical event again once the window has passed", async () => {
        // Same original_timestamp on purpose: an event created after the
        // clock moves would hash differently on its own, which would prove
        // nothing about the window.
        const event = createMockEvent();
        await eventQueue.enqueue(event);
        await (eventQueue as any).pendingFlush;

        clock.tick(60_001);
        await eventQueue.enqueue({ ...event });
        expect((eventQueue as any).queue).to.have.length(1);
        expect((eventQueue as any).payloadHashes.size, "expired id pruned, new one recorded").to.equal(1);
      });

      it("catches a double-fire that straddles a UTC minute boundary", async () => {
        // message_id folds in the minute-truncated timestamp (it is the
        // event's identity on the wire), so these two get DIFFERENT ids.
        // The dedup key must not care: it is the same event 2ms apart.
        await eventQueue.enqueue(createMockEvent({ properties: { n: 1 } }));
        await (eventQueue as any).pendingFlush;

        clock.setSystemTime(new Date("2026-08-27T12:34:59.999Z"));
        const first = createMockEvent({ original_timestamp: new Date().toISOString() });
        await eventQueue.enqueue(first);
        expect((eventQueue as any).queue).to.have.length(1);

        clock.setSystemTime(new Date("2026-08-27T12:35:00.001Z"));
        const second = { ...first, original_timestamp: new Date().toISOString() };
        expect(second.original_timestamp).to.not.equal(first.original_timestamp);
        await eventQueue.enqueue(second);
        expect((eventQueue as any).queue, "the copy across the boundary is dropped").to.have.length(1);
      });

      it("keeps message ids distinct across minutes while deduping by content", async () => {
        // Same content a full window apart: both go out, with different
        // ids, because the id must never collide for events a minute apart.
        const event = createMockEvent({ properties: { n: 1 } });
        await eventQueue.enqueue(event);
        await (eventQueue as any).pendingFlush;
        const firstId = JSON.parse(fetchStub.firstCall.args[1].body)[0].message_id;

        clock.tick(60_001);
        await eventQueue.enqueue({ ...event, original_timestamp: new Date().toISOString() });
        expect((eventQueue as any).queue).to.have.length(1);
        expect((eventQueue as any).queue[0].message.message_id).to.not.equal(firstId);
      });

      it("prunes only from the front and stops at the first live entry", async () => {
        // Ten distinct events spread over the window, then one more after
        // the oldest six expired: exactly those six are gone.
        for (let i = 0; i < 10; i++) {
          await eventQueue.enqueue(createMockEvent({ properties: { i } }));
          clock.tick(5_000);
        }
        await (eventQueue as any).pendingFlush;
        expect((eventQueue as any).payloadHashes.size).to.equal(10);

        // t = 50s now. Entry i expires at 5i + 60 s. At 90s that is i in
        // 0..6: entry 6 expires at exactly 90s, and an entry is dead the
        // instant its expiry is reached. Entries 7..9 (95s, 100s, 105s) live.
        clock.tick(40_000);
        await eventQueue.enqueue(createMockEvent({ properties: { i: 99 } }));
        expect((eventQueue as any).payloadHashes.size).to.equal(10 - 7 + 1);

        // A survivor is still enforced, and an expired one is accepted again.
        await eventQueue.enqueue(createMockEvent({ properties: { i: 9 } }));
        expect((eventQueue as any).queue.map((q: any) => q.message.properties.i)).to.not.include(9);
        expect((eventQueue as any).payloadHashes.size).to.equal(4);
        await eventQueue.enqueue(createMockEvent({ properties: { i: 0 } }));
        expect((eventQueue as any).payloadHashes.size).to.equal(5);
      });

      it("releases the fingerprint of an event whose send failed, so it can be sent again", async () => {
        // A 400 is not retryable, so the batch is lost. The app hears about
        // it through the callback; if it sends the same event again within
        // the window, that is a retry, not a double-fire.
        await eventQueue.enqueue(createMockEvent({ properties: { n: 1 } }));
        await (eventQueue as any).pendingFlush;

        fetchStub.resolves(makeResponse(400, "Bad Request"));
        const event = createMockEvent({ properties: { n: 2 } });
        const cb = sinon.spy();
        await eventQueue.enqueue(event, cb);
        await eventQueue.flush();
        expect(cb.calledOnce).to.be.true;
        expect(cb.firstCall.args[0], "callback saw the error").to.be.an("error");

        fetchStub.resolves(makeResponse(200, "OK"));
        await eventQueue.enqueue({ ...event });
        expect((eventQueue as any).queue, "the retry is accepted").to.have.length(1);
      });

      it("does not release a newer fingerprint when an old send fails after the window", async () => {
        // Retry backoff can keep a send in flight past the window. If the
        // same event is accepted again meanwhile, the old failure must not
        // release the NEW entry, or a third copy slips through.
        await eventQueue.enqueue(createMockEvent({ properties: { n: 1 } }));
        await (eventQueue as any).pendingFlush;

        let settle: (r: Response) => void = () => undefined;
        fetchStub.callsFake(() => new Promise<Response>((r) => { settle = r; }));
        const event = createMockEvent({ properties: { n: 2 } });
        await eventQueue.enqueue(event);
        const inFlight = eventQueue.flush();
        await clock.tickAsync(0);

        // Window passes while the send hangs; the same event is accepted anew.
        clock.tick(60_001);
        await eventQueue.enqueue({ ...event });
        expect((eventQueue as any).queue, "re-accepted after expiry").to.have.length(1);

        settle(makeResponse(400, "Bad Request"));
        await inFlight;

        await eventQueue.enqueue({ ...event });
        expect((eventQueue as any).queue, "the newer entry still suppresses").to.have.length(1);
      });

      it("keeps a delivered event's fingerprint across an opt-out / opt-in round trip", async () => {
        // clear() runs on consent withdrawal while a spliced batch is still
        // in flight. That batch reaches the wire, so a copy sent after
        // consent returns is a duplicate, and must still be dropped.
        let allowed = true;
        eventQueue = new EventQueue("test-key", {
          apiHost: "https://api.example.com",
          flushAt: 20,
          flushInterval: 30000,
          canSend: () => allowed,
        });
        await eventQueue.enqueue(createMockEvent({ properties: { n: 1 } }));
        await (eventQueue as any).pendingFlush;

        let settle: (r: Response) => void = () => undefined;
        fetchStub.callsFake(() => new Promise<Response>((r) => { settle = r; }));
        const inFlightEvent = createMockEvent({ properties: { n: 2 } });
        await eventQueue.enqueue(inFlightEvent);
        const inFlight = eventQueue.flush();
        await clock.tickAsync(0);

        // Buffered behind the in-flight batch, then abandoned by clear().
        const bufferedEvent = createMockEvent({ properties: { n: 3 } });
        await eventQueue.enqueue(bufferedEvent);
        allowed = false;
        eventQueue.clear();
        allowed = true;

        settle(makeResponse(200, "OK"));
        await inFlight;

        await eventQueue.enqueue({ ...inFlightEvent });
        expect((eventQueue as any).queue, "the delivered event still suppresses").to.have.length(0);
        await eventQueue.enqueue({ ...bufferedEvent });
        expect((eventQueue as any).queue, "the abandoned event is accepted again").to.have.length(1);
      });

      it("forgets everything on close()", async () => {
        const event = createMockEvent({ properties: { n: 1 } });
        await eventQueue.enqueue(event);
        await (eventQueue as any).pendingFlush;
        expect((eventQueue as any).payloadHashes.size).to.equal(1);
        eventQueue.close();
        expect((eventQueue as any).payloadHashes.size).to.equal(0);
      });

      it("releases the fingerprints of batches abandoned when consent is withdrawn mid-flush", async () => {
        let allowed = true;
        eventQueue = new EventQueue("test-key", {
          apiHost: "https://api.example.com",
          flushAt: 20,
          flushInterval: 30000,
          canSend: () => allowed,
        });
        const largeProps: Record<string, string> = {};
        for (let i = 0; i < 50; i++) largeProps[`field_${i}`] = "x".repeat(200);
        const events = Array.from({ length: 8 }, (_, i) =>
          createMockEvent({ properties: { ...largeProps, index: i } })
        );
        for (const e of events) await eventQueue.enqueue(e);
        await (eventQueue as any).pendingFlush; // the first event's own flush
        fetchStub.resetHistory();

        // The remaining seven exceed 64KB and split. Consent goes away as the
        // first split batch is sent; the rest are abandoned unsent.
        fetchStub.callsFake(async () => { allowed = false; return makeResponse(200, "OK"); });
        await eventQueue.flush();
        expect(fetchStub.calledOnce).to.be.true;
        const sent = new Set(
          JSON.parse(fetchStub.firstCall.args[1].body).map((e: any) => e.properties.index)
        );
        const abandoned = events.find((e) => (e.properties as any).index !== 0 && !sent.has((e.properties as any).index))!;
        const delivered = events.find((e) => sent.has((e.properties as any).index))!;
        expect(abandoned, "some batch was abandoned").to.exist;

        allowed = true;
        await eventQueue.enqueue({ ...abandoned });
        expect((eventQueue as any).queue, "an abandoned event can be sent again").to.have.length(1);
        await eventQueue.enqueue({ ...delivered });
        expect((eventQueue as any).queue, "a delivered one is still a duplicate").to.have.length(1);
      });

      it("abandons the batches behind an in-flight one after an opt-out / opt-in round trip", async () => {
        // Consent sampled true again at the next batch boundary is not
        // enough: these batches were spliced before the withdrawal, and
        // clear() could not reach them. The generation counter can.
        let allowed = true;
        eventQueue = new EventQueue("test-key", {
          apiHost: "https://api.example.com",
          flushAt: 20,
          flushInterval: 30000,
          canSend: () => allowed,
        });
        const largeProps: Record<string, string> = {};
        for (let i = 0; i < 50; i++) largeProps[`field_${i}`] = "x".repeat(200);
        const events = Array.from({ length: 8 }, (_, i) =>
          createMockEvent({ properties: { ...largeProps, index: i } })
        );
        for (const e of events) await eventQueue.enqueue(e);
        await (eventQueue as any).pendingFlush;
        fetchStub.resetHistory();

        let settle: (r: Response) => void = () => undefined;
        fetchStub.callsFake(() => new Promise<Response>((r) => { settle = r; }));
        const inFlight = eventQueue.flush();
        await clock.tickAsync(0);
        expect(fetchStub.calledOnce, "first split batch is in flight").to.be.true;

        allowed = false;
        eventQueue.clear();
        allowed = true;
        settle(makeResponse(200, "OK"));
        await inFlight;

        expect(fetchStub.calledOnce, "no further batch was sent").to.be.true;
        const sent = new Set(
          JSON.parse(fetchStub.firstCall.args[1].body).map((e: any) => e.properties.index)
        );
        const abandoned = events.find((e) => (e.properties as any).index !== 0 && !sent.has((e.properties as any).index))!;
        await eventQueue.enqueue({ ...abandoned });
        expect((eventQueue as any).queue, "an abandoned event can be sent again").to.have.length(1);
      });

      it("does not POST an empty batch when clear() empties the queue while flush waits", async () => {
        let settle: (r: Response) => void = () => undefined;
        fetchStub.callsFake(() => new Promise<Response>((r) => { settle = r; }));
        await eventQueue.enqueue(createMockEvent({ properties: { n: 1 } })); // in flight
        await eventQueue.enqueue(createMockEvent({ properties: { n: 2 } })); // buffered
        const waiting = eventQueue.flush(); // waits on the in-flight one
        eventQueue.clear();
        settle(makeResponse(200, "OK"));
        await waiting;

        expect(fetchStub.calledOnce, "only the first event's flush hit the network").to.be.true;
        expect(JSON.parse(fetchStub.firstCall.args[1].body)).to.have.length(1);
      });

      it("keeps the fingerprint of an event whose send succeeded", async () => {
        const event = createMockEvent({ properties: { n: 1 } });
        await eventQueue.enqueue(event);
        await (eventQueue as any).pendingFlush;
        await eventQueue.enqueue({ ...event });
        expect((eventQueue as any).queue).to.have.length(0);
      });

      it("counts a forward wall-clock step toward expiry, and ignores a backward one", async () => {
        const event = createMockEvent({ properties: { n: 1 } });
        await eventQueue.enqueue(event);
        await (eventQueue as any).pendingFlush;

        // Backward step of an hour with no elapsed time: still inside the
        // window, still a duplicate.
        clock.setSystemTime(Date.now() - 3_600_000);
        await eventQueue.enqueue({ ...event });
        expect((eventQueue as any).queue, "backward step does not reopen").to.have.length(0);

        // Forward step past the window with no monotonic time elapsed
        // (a device that slept): the window has run out.
        clock.setSystemTime(Date.now() + 3_600_000 + 60_001);
        await eventQueue.enqueue({ ...event });
        expect((eventQueue as any).queue, "forward step expires").to.have.length(1);
      });

      it("keeps real pace after a forward wall-clock jump that is later corrected", async () => {
        // A forward step counts (safe: expires early). The correction back
        // must not leave the clock pinned: an event accepted after it must
        // still expire 60s of real time later, not an hour later.
        await eventQueue.enqueue(createMockEvent({ properties: { n: 1 } }));
        await (eventQueue as any).pendingFlush;

        const t0 = Date.now();
        clock.setSystemTime(t0 + 3_600_000);
        // Sample the dedup clock while jumped, so the forward delta is
        // actually taken; without a read here the jump is invisible.
        await eventQueue.enqueue(createMockEvent({ properties: { n: 99 } }));
        expect((eventQueue as any).elapsedNow(), "the jump was counted").to.be.at.least(3_600_000);
        clock.setSystemTime(t0);
        const event = createMockEvent({ properties: { n: 2 } });
        await eventQueue.enqueue(event);
        expect((eventQueue as any).queue).to.have.length(2);
        await eventQueue.flush();

        clock.tick(30_000);
        await eventQueue.enqueue({ ...event });
        expect((eventQueue as any).queue, "inside the window: duplicate").to.have.length(0);

        clock.tick(30_001);
        await eventQueue.enqueue({ ...event });
        expect((eventQueue as any).queue, "60s of real time later: accepted").to.have.length(1);
      });

      it("still suppresses a duplicate of an event waiting in the queue", async () => {
        await eventQueue.enqueue(createMockEvent({ properties: { n: 1 } }));
        await (eventQueue as any).pendingFlush;

        const queued = createMockEvent({ properties: { n: 2 } });
        await eventQueue.enqueue(queued);
        await eventQueue.enqueue({ ...queued });
        expect((eventQueue as any).queue).to.have.length(1);
      });
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
      useUniqueCryptoHashes();
      let allowed = true;
      eventQueue = new EventQueue("test-key", {
        apiHost: "https://api.example.com",
        flushAt: 20,
        flushInterval: 30000,
        retryCount: 1,
        canSend: () => allowed,
      });

      // The first event flushes immediately while consent is still granted;
      // let it through so the next enqueue exercises the buffered path.
      await eventQueue.enqueue(createMockEvent());
      await (eventQueue as any).pendingFlush;
      fetchStub.resetHistory();

      // Distinct from the first: a same-minute copy would be dropped as a
      // duplicate before ever reaching the buffer.
      await eventQueue.enqueue(createMockEvent({ properties: { n: 2 } }));
      expect((eventQueue as any).queue, "event is buffered").to.have.length(1);
      allowed = false; // consent withdrawn while buffered
      await eventQueue.flush();

      expect(fetchStub.called, "no network send after opt-out").to.be.false;
    });

    it("does not buffer an event whose consent was withdrawn while it was being hashed", async () => {
      // enqueue() suspends on its hash awaits after passing the consent
      // gate. Withdrawal in that gap must still stop the event from being
      // buffered or remembered as accepted, not merely from being sent.
      useUniqueCryptoHashes();
      let allowed = true;
      eventQueue = new EventQueue("test-key", {
        apiHost: "https://api.example.com",
        flushAt: 20,
        flushInterval: 30000,
        retryCount: 1,
        canSend: () => allowed,
      });
      await eventQueue.enqueue(createMockEvent({ properties: { n: 1 } }));
      await (eventQueue as any).pendingFlush;
      fetchStub.resetHistory();

      const suspended = eventQueue.enqueue(createMockEvent({ properties: { n: 2 } }));
      allowed = false;
      await suspended;

      expect((eventQueue as any).queue, "nothing buffered").to.have.length(0);
      expect(
        (eventQueue as any).payloadHashes.size,
        "only the delivered first event is remembered"
      ).to.equal(1);
      await eventQueue.flush();
      expect(fetchStub.called).to.be.false;

      // Consent returns: the withheld event was never accepted, so it goes.
      allowed = true;
      await eventQueue.enqueue(createMockEvent({ properties: { n: 2 } }));
      expect((eventQueue as any).queue, "accepted once consent is back").to.have.length(1);
    });

    it("drops an event whose consent was withdrawn AND restored while it was being hashed", async () => {
      // Sampling consent after the awaits sees it granted again. The event
      // predates the withdrawal, and clear() dropped everything pending
      // then, so it must not slip through on the round trip.
      useUniqueCryptoHashes();
      let allowed = true;
      eventQueue = new EventQueue("test-key", {
        apiHost: "https://api.example.com",
        flushAt: 20,
        flushInterval: 30000,
        retryCount: 1,
        canSend: () => allowed,
      });
      await eventQueue.enqueue(createMockEvent({ properties: { n: 1 } }));
      await (eventQueue as any).pendingFlush;
      fetchStub.resetHistory();

      const event = createMockEvent({ properties: { n: 2 } });
      const suspended = eventQueue.enqueue(event);
      allowed = false;
      eventQueue.clear(); // what optOutTracking() does
      allowed = true;
      await suspended;

      expect((eventQueue as any).queue, "nothing buffered").to.have.length(0);
      await eventQueue.flush();
      expect(fetchStub.called).to.be.false;

      // Not remembered either: a fresh send of it after opt-in goes.
      await eventQueue.enqueue({ ...event });
      expect((eventQueue as any).queue, "accepted afresh").to.have.length(1);
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

      // Let the immediate first-event flush through, then test clear()
      // against events that are actually buffered.
      await eventQueue.enqueue(createMockEvent());
      await (eventQueue as any).pendingFlush;
      fetchStub.resetHistory();

      await eventQueue.enqueue(createMockEvent({ properties: { n: 2 } }));
      await eventQueue.enqueue(createMockEvent({ properties: { n: 3 } }));
      expect((eventQueue as any).queue, "events are buffered").to.have.length(2);
      eventQueue.clear();
      await eventQueue.flush();
      expect(fetchStub.called, "cleared events are not sent").to.be.false;

      // Queue still works after clear (byteSize/state re-anchored).
      await eventQueue.enqueue(createMockEvent({ properties: { n: 4 } }));
      await eventQueue.flush();
      expect(fetchStub.calledOnce, "post-clear enqueue still flushes").to.be
        .true;
    });
  });

  describe("close", () => {
    it("should refuse to enqueue after close, even on a queue that never flushed", async () => {
      const fetchStub = sinon.stub(fetchModule, "default").resolves(makeResponse(200, "OK"));
      eventQueue = new EventQueue("test-key", { apiHost: "https://api.example.com" });

      eventQueue.close();
      // A fresh queue flushes its very first event immediately, so if the
      // enqueue guard were missing this would reach the wire at once.
      await eventQueue.enqueue(createMockEvent());
      await clock.tickAsync(60_000);

      expect(fetchStub.called).to.be.false;
    });

    it("should drop an event that was already inside enqueue when close ran", async () => {
      const fetchStub = sinon.stub(fetchModule, "default").resolves(makeResponse(200, "OK"));
      eventQueue = new EventQueue("test-key", { apiHost: "https://api.example.com" });

      // Start enqueue, so it is suspended on its message-hash await, THEN
      // close. The entry guard has already been passed at this point, so
      // only a re-check after the await can stop it.
      const pending = eventQueue.enqueue(createMockEvent());
      eventQueue.close();
      await pending;
      await clock.tickAsync(60_000);

      expect(fetchStub.called).to.be.false;
    });

    it("should drop an event that arrives after close but was built before it", async () => {
      const fetchStub = sinon.stub(fetchModule, "default").resolves(makeResponse(200, "OK"));
      eventQueue = new EventQueue("test-key", { apiHost: "https://api.example.com" });

      // Mirrors the real teardown race: the caller started building this
      // event before cleanup and only reaches the queue afterwards.
      const inFlight = Promise.resolve().then(() => eventQueue.enqueue(createMockEvent()));
      eventQueue.close();
      await inFlight;
      await clock.tickAsync(60_000);

      expect(fetchStub.called).to.be.false;
    });

    it("should stop a flush already scheduled on the batch timer", async () => {
      useUniqueCryptoHashes();
      const fetchStub = sinon.stub(fetchModule, "default").resolves(makeResponse(200, "OK"));
      eventQueue = new EventQueue("test-key", {
        apiHost: "https://api.example.com",
        flushInterval: 10_000,
      });

      // First event flushes immediately; the second only arms the timer.
      await eventQueue.enqueue(createMockEvent());
      await clock.tickAsync(0);
      const afterFirst = fetchStub.callCount;
      await eventQueue.enqueue(createMockEvent({ properties: { n: 2 } }));

      eventQueue.close();
      await clock.tickAsync(30_000);

      expect(afterFirst).to.equal(1);
      expect(fetchStub.callCount).to.equal(afterFirst);
    });

    it("should remove the page-leave listeners", async () => {
      eventQueue = new EventQueue("test-key", { apiHost: "https://api.example.com" });
      const flushSpy = sinon.spy(eventQueue, "flush");

      const leave = async () => {
        jsdom.window.dispatchEvent(new jsdom.window.Event("beforeunload"));
        // handleOnLeave latches on the first event of a burst and releases
        // the latch on a 0ms timer. Without this tick every later dispatch
        // is swallowed by the latch, and the assertion after close would
        // hold whether or not the listener was ever removed.
        await clock.tickAsync(1);
      };

      await leave();
      expect(flushSpy.callCount, "listener should be live on the first leave").to.equal(1);
      await leave();
      expect(flushSpy.callCount, "listener should fire again once the latch releases").to.equal(2);

      eventQueue.close();

      await leave();
      expect(flushSpy.callCount, "listener should be gone after close").to.equal(2);
    });

    it("should still remove its listeners when the globals have moved on", async () => {
      eventQueue = new EventQueue("test-key", { apiHost: "https://api.example.com" });
      const flushSpy = sinon.spy(eventQueue, "flush");
      const installedDocument = jsdom.window.document;

      // Teardown can run after the host swapped these out. Removal must still
      // target the objects the listeners were added to.
      const other = new JSDOM("<!DOCTYPE html><html><body></body></html>");
      Object.defineProperty(global, "document", {
        value: other.window.document, writable: true, configurable: true,
      });

      eventQueue.close();

      Object.defineProperty(global, "document", {
        value: installedDocument, writable: true, configurable: true,
      });
      // The page-leave callback only flushes when the page became
      // inaccessible, so the document has to actually report hidden.
      Object.defineProperty(installedDocument, "visibilityState", {
        value: "hidden", configurable: true,
      });
      installedDocument.dispatchEvent(new jsdom.window.Event("visibilitychange"));
      await clock.tickAsync(1);

      expect(flushSpy.called, "the document listener should be gone").to.be.false;
      other.window.close();
    });

    it("should report closed state and tolerate repeat calls", () => {
      eventQueue = new EventQueue("test-key", { apiHost: "https://api.example.com" });
      expect(eventQueue.isClosed).to.be.false;
      eventQueue.close();
      eventQueue.close();
      expect(eventQueue.isClosed).to.be.true;
    });

    it("should keep clear() recoverable, unlike close()", async () => {
      useUniqueCryptoHashes();
      const fetchStub = sinon.stub(fetchModule, "default").resolves(makeResponse(200, "OK"));
      eventQueue = new EventQueue("test-key", { apiHost: "https://api.example.com" });

      // clear() is consent withdrawal, which the user can reverse.
      eventQueue.clear();
      await eventQueue.enqueue(createMockEvent());
      await clock.tickAsync(0);

      expect(fetchStub.callCount).to.equal(1);
      expect(eventQueue.isClosed).to.be.false;
    });
  });
});
