import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import { JSDOM } from "jsdom";
import { EventManager } from "../../../src/event/EventManager";
import { IEventQueue } from "../../../src/queue";
import { APIEvent } from "../../../src/types";
import { initStorageManager } from "../../../src/storage";

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
      clear: sinon.spy(),
      close: sinon.spy(),
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

    it("deduplicates track calls before volatile SDK context is added", async () => {
      const apiEvent: APIEvent = {
        type: "track",
        event: "Checkout Completed",
        properties: { plan: "pro", amount: 99 },
        context: { source: "confirmation" },
      };

      await eventManager.addEvent(apiEvent);
      document.title = "Pricing updated";
      await eventManager.addEvent({ ...apiEvent });

      const firstEvent = enqueueSpy.firstCall.args[0];
      const secondEvent = enqueueSpy.secondCall.args[0];
      const firstOptions = enqueueSpy.firstCall.args[2];
      const secondOptions = enqueueSpy.secondCall.args[2];
      expect(firstEvent.context.page_title).to.not.equal(
        secondEvent.context.page_title
      );
      expect(secondOptions.dedupKey).to.equal(firstOptions.dedupKey);
    });

    it("fingerprints property bags built in a different order the same", async () => {
      await eventManager.addEvent({ type: "track", event: "Purchase", properties: { currency: "USD", amount: 10, meta: { a: 1, b: 2 } } });
      await eventManager.addEvent({ type: "track", event: "Purchase", properties: { amount: 10, meta: { b: 2, a: 1 }, currency: "USD" } });
      await eventManager.addEvent({ type: "track", event: "Purchase", properties: { currency: "USD", amount: 10, meta: { a: 1, b: 2 }, items: [1, 2] } });
      await eventManager.addEvent({ type: "track", event: "Purchase", properties: { currency: "USD", amount: 10, meta: { a: 1, b: 2 }, items: [2, 1] } });

      const keys = enqueueSpy.getCalls().map((c) => c.args[2].dedupKey);
      expect(keys[1], "key order does not matter").to.equal(keys[0]);
      expect(keys[3], "array order does").to.not.equal(keys[2]);
    });

    it("keeps an own __proto__ key in the fingerprint", async () => {
      const withProto = JSON.parse('{"__proto__": {"a": 1}, "x": 1}');
      const without = { x: 1 };
      await eventManager.addEvent({ type: "track", event: "Purchase", properties: withProto });
      await eventManager.addEvent({ type: "track", event: "Purchase", properties: without });

      const keys = enqueueSpy.getCalls().map((c) => c.args[2].dedupKey);
      expect(keys[0]).to.not.equal(keys[1]);
    });

    it("answers the callback with the closed code when creation is cancelled by teardown", async () => {
      const callback = sinon.stub();
      const pending = eventManager.addEvent({ type: "track", event: "Purchase", callback } as any);
      eventManager.close(); // cleanup() while enrichment is pending
      await pending;

      expect(enqueueSpy.called).to.be.false;
      expect(callback.calledOnce).to.be.true;
      expect(callback.firstCall.args[0].code).to.equal("closed");
    });

    it("throws the native error on a cycle, and unboxes primitive wrappers", async () => {
      const cyc: Record<string, unknown> = { a: 1 };
      cyc.self = cyc;
      let thrown: unknown;
      try {
        await eventManager.addEvent({ type: "track", event: "Purchase", properties: cyc });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).to.be.instanceOf(TypeError);

      await eventManager.addEvent({ type: "track", event: "Purchase", properties: { amount: new Number(1) as any } });
      await eventManager.addEvent({ type: "track", event: "Purchase", properties: { amount: new Number(2) as any } });
      const keys = enqueueSpy.getCalls().map((c) => c.args[2].dedupKey);
      expect(keys[0]).to.not.equal(keys[1]);
    });

    it("passes the property key to toJSON, and unboxes through the built-in methods", async () => {
      const keyed = { toJSON: (k: string) => k };
      await eventManager.addEvent({ type: "track", event: "Purchase", properties: { x: keyed } });
      await eventManager.addEvent({ type: "track", event: "Purchase", properties: { y: keyed } });
      // eslint-disable-next-line @typescript-eslint/no-wrapper-object-types
      const boxed = new String("real") as String & { valueOf: () => string };
      boxed.valueOf = () => "override";
      await eventManager.addEvent({ type: "track", event: "Purchase", properties: { s: boxed as any } });
      await eventManager.addEvent({ type: "track", event: "Purchase", properties: { s: "real" } });

      const keys = enqueueSpy.getCalls().map((c) => c.args[2].dedupKey);
      expect(keys[0], "different keys reach toJSON").to.not.equal(keys[1]);
      expect(keys[2], "the wrapper unboxes to its real value").to.equal(keys[3]);
    });

    it("runs toJSON once per property, as JSON.stringify does", async () => {
      const inner1 = { a: 1, toJSON: () => 0 };
      const inner2 = { a: 2, toJSON: () => 0 };
      await eventManager.addEvent({ type: "track", event: "Purchase", properties: { p: { toJSON: () => inner1 } as any } });
      await eventManager.addEvent({ type: "track", event: "Purchase", properties: { p: { toJSON: () => inner2 } as any } });
      const keys = enqueueSpy.getCalls().map((c) => c.args[2].dedupKey);
      expect(keys[0], "the returned object's own hook is not run again").to.not.equal(keys[1]);
    });

    it("honors a toJSON hook on a function value, and reads the hook once", async () => {
      const { stableStringify } = await import("../../../src/utils/generate");
      const fn = Object.assign(() => undefined, { toJSON: () => "fn" });
      expect(stableStringify({ f: fn })).to.equal(JSON.stringify({ f: fn }));
      expect(stableStringify({ g: () => undefined })).to.equal(JSON.stringify({ g: () => undefined }));
      let reads = 0;
      const flaky = { a: 1, get toJSON() { reads++; return reads === 1 ? () => "once" : undefined; } };
      expect(stableStringify({ p: flaky })).to.equal('{"p":"once"}');
    });

    it("honors a BigInt.prototype.toJSON hook and an overridden call on a hook", async () => {
      const { stableStringify } = await import("../../../src/utils/generate");
      const proto = BigInt.prototype as unknown as { toJSON?: () => string };
      proto.toJSON = function () { return this.toString(); };
      try {
        expect(stableStringify({ amount: BigInt(123) })).to.equal(JSON.stringify({ amount: BigInt(123) }));
      } finally {
        delete proto.toJSON;
      }
      expect(() => stableStringify({ amount: BigInt(5) })).to.throw(TypeError);
      const hook = Object.assign(() => "ok", { call: () => { throw new Error("overridden"); } });
      expect(stableStringify({ p: { toJSON: hook } })).to.equal(JSON.stringify({ p: { toJSON: hook } }));
    });

    it("serializes without BigInt in the runtime", async () => {
      const { stableStringify } = await import("../../../src/utils/generate");
      const saved = (globalThis as any).BigInt;
      (globalThis as any).BigInt = undefined;
      try {
        expect(stableStringify({ b: 2, a: { d: 1, c: [1] } })).to.equal('{"a":{"c":[1],"d":1},"b":2}');
      } finally {
        (globalThis as any).BigInt = saved;
      }
    });

    it("rejects a boxed bigint and reads an array length once", async () => {
      const { stableStringify } = await import("../../../src/utils/generate");
      expect(() => stableStringify({ n: Object(BigInt(1)) })).to.throw(TypeError);
      let reads = 0;
      const growing = new Proxy([1, 2], { get: (t, p, r) => { if (p === "length") { reads++; if (reads > 1) t.push(0); } return Reflect.get(t, p, r); } });
      expect(stableStringify({ a: growing })).to.equal('{"a":[1,2]}');
    });

    it("answers the callback when creation is cancelled by consent", async () => {
      const callback = sinon.stub();
      const pending = eventManager.addEvent({ type: "track", event: "Purchase", callback } as any);
      eventManager.clear(); // consent withdrawn while enrichment is pending
      await pending;

      expect(enqueueSpy.called, "nothing is queued").to.be.false;
      expect(callback.calledOnce).to.be.true;
      expect(callback.firstCall.args[0].code).to.equal("consent_withdrawn");
    });

    it("fingerprints the caller input as it was when track() was called", async () => {
      const properties: Record<string, unknown> = { market: "ZEC", volume: 3571 };
      const first = eventManager.addEvent({ type: "track", event: "Order Placed", properties });
      // The app reuses and mutates the object while enrichment is pending.
      properties.volume = 9999;
      await first;
      await eventManager.addEvent({
        type: "track",
        event: "Order Placed",
        properties: { market: "ZEC", volume: 3571 },
      });

      // Same input, same fingerprint: the mutation did not leak into the key.
      expect(enqueueSpy.secondCall.args[2].dedupKey).to.equal(
        enqueueSpy.firstCall.args[2].dedupKey
      );
    });

    it("keeps caller-supplied context in the track fallback fingerprint", async () => {
      const base: APIEvent = {
        type: "track",
        event: "Checkout Completed",
        properties: { plan: "pro", amount: 99 },
      };

      await eventManager.addEvent({ ...base, context: { source: "button" } });
      await eventManager.addEvent({ ...base, context: { source: "api" } });

      expect(enqueueSpy.firstCall.args[2].dedupKey).to.not.equal(
        enqueueSpy.secondCall.args[2].dedupKey
      );
    });

    it("forwards idempotency without adding it to the event payload", async () => {
      const apiEvent: APIEvent = {
        type: "track",
        event: "Checkout Completed",
        properties: { plan: "pro" },
        idempotencyKey: "checkout-123",
      };

      await eventManager.addEvent(apiEvent);

      expect(enqueueSpy.firstCall.args[0]).not.to.have.property("idempotencyKey");
      expect(enqueueSpy.firstCall.args[2].idempotencyKey).to.equal("checkout-123");
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

  describe("clear", () => {
    it("delegates to the event queue's clear()", () => {
      eventManager.clear();
      expect((mockEventQueue.clear as sinon.SinonSpy).calledOnce).to.be.true;
    });
  });
});
