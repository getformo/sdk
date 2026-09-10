import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import { JSDOM } from "jsdom";
import { FormoAnalytics } from "../src/FormoAnalytics";
import { initStorageManager } from "../src/storage";
import * as fetchModule from "../src/fetch";

/**
 * Regression for issue #339.
 *
 * `cleanup()` used to only *clear* the event queue. Clearing empties the
 * buffer at that instant, but every emit path builds its event
 * asynchronously, so work already in flight still enqueued afterwards - and
 * because the queue was empty at that point, the late event flushed straight
 * away. A torn-down instance could therefore still send, using its own stale
 * options. `cleanup()` now *closes* the queue instead, which is terminal.
 */
describe("Teardown closes the event queue", () => {
  let sandbox: sinon.SinonSandbox;
  let jsdom: JSDOM;
  const ADDRESS = "0x51377e9B985Bb90B7c091B9a7d30C93d4c9c1CEf";

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    jsdom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
      url: "https://example.com",
    });
    for (const [k, v] of [
      ["window", jsdom.window],
      ["globalThis", jsdom.window],
      ["document", jsdom.window.document],
      ["location", jsdom.window.location],
      ["navigator", jsdom.window.navigator],
      ["localStorage", jsdom.window.localStorage],
      ["sessionStorage", jsdom.window.sessionStorage],
      ["Event", jsdom.window.Event],
      ["CustomEvent", jsdom.window.CustomEvent],
    ] as const) {
      Object.defineProperty(global, k, { value: v, writable: true, configurable: true });
    }
    for (const fn of ["addEventListener", "removeEventListener", "dispatchEvent"] as const) {
      Object.defineProperty(global, fn, {
        value: (jsdom.window as any)[fn].bind(jsdom.window),
        writable: true, configurable: true,
      });
    }
    Object.defineProperty(global, "crypto", {
      value: { randomUUID: () => "mock-uuid" }, writable: true, configurable: true,
    });
    initStorageManager("test-write-key");
  });

  afterEach(() => {
    sandbox.restore();
    for (const k of ["window","document","location","navigator",
      "localStorage","sessionStorage","crypto"]) {
      delete (global as any)[k];
    }
    jsdom?.window.close();
  });

  /**
   * Watches the wire, not `enqueue`. A closed queue still *accepts* the call
   * and discards it, so spying on `enqueue` would report a hit for an event
   * that was correctly dropped. What must never happen is a request.
   *
   * `sent()` returns only the events this test raised. Other specs leak live
   * SDK instances whose batch timers fire during our window (see issue #338),
   * and a bare `stub.called` check turns that into order-dependent flake.
   */
  function watchWire() {
    const stub = sandbox.stub(fetchModule, "default").resolves({
      ok: true, status: 200, statusText: "OK", text: async () => "",
    } as Response);
    const sent = (): any[] =>
      stub.args.flatMap((call: any) => {
        try {
          return JSON.parse(call?.[1]?.body ?? "[]");
        } catch {
          return [];
        }
      }).filter((e: any) => MINE.includes(e?.type));
    return Object.assign(sent, { stub });
  }
  /** Event types this spec raises, and nothing else does. */
  const MINE = ["connect", "custom-event"];

  it("drops an event whose async build straddles cleanup()", async () => {
    const formo = await FormoAnalytics.init("test-write-key", { tracking: true });
    const sent = watchWire();

    // Hold event creation open so cleanup lands in the middle of it, which
    // is the real race: a provider remount or an options change tears the
    // instance down while an emit is still resolving.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const factory = (formo as any).eventManager.eventFactory;
    const create = factory.create.bind(factory);
    sandbox.stub(factory, "create").callsFake(async (...args: unknown[]) => {
      await gate;
      return create(...args);
    });

    const inFlight = formo.connect({ chainId: 1, address: ADDRESS as `0x${string}` });
    formo.cleanup();
    release();
    await inFlight;
    await new Promise((r) => setTimeout(r, 20));

    expect(
      sent(),
      "an emit that outlived the instance must not reach the wire"
    ).to.deep.equal([]);
  });

  it("refuses events raised after cleanup()", async () => {
    const formo = await FormoAnalytics.init("test-write-key", { tracking: true });
    const sent = watchWire();

    formo.cleanup();
    await formo.connect({ chainId: 1, address: ADDRESS as `0x${string}` });
    await formo.track("custom-event", { a: 1 });
    await new Promise((r) => setTimeout(r, 20));

    expect(sent(), "a torn-down instance must send nothing").to.deep.equal([]);
  });

  it("still accepts events before cleanup(), so the guard is not blanket", async () => {
    const formo = await FormoAnalytics.init("test-write-key", { tracking: true });
    const sent = watchWire();

    await formo.connect({ chainId: 1, address: ADDRESS as `0x${string}` });
    await new Promise((r) => setTimeout(r, 20));

    expect(
      sent().map((e: any) => e.type),
      "a live instance must still reach the wire"
    ).to.include("connect");
  });

  /**
   * The events these tests raise, in wire order, matched by name so a leak
   * from another spec (issue #338) cannot be counted.
   */
  const delivered = (sent: { stub: sinon.SinonStub }): string[] =>
    sent.stub.args
      .flatMap((call: any) => {
        try {
          return JSON.parse(call?.[1]?.body ?? "[]");
        } catch {
          return [];
        }
      })
      .filter((e: any) => e?.type === "connect" || e?.event === "custom-event")
      .map((e: any) => e.event ?? e.type);

  /**
   * The first event of a page load is sent at once and the queue batches from
   * then on, so a warm-up event is what makes later ones buffer.
   */
  const warmUp = async (formo: any, sent: any) => {
    await formo.track("custom-event", { warmUp: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(delivered(sent).length, "the first event goes out on its own").to.equal(1);
  };

  it("delivers events still buffered when cleanup() runs", async () => {
    // Found by the browser run of the Solana example: a cluster change
    // re-creates the SDK while the connect is still buffered.
    const formo = await FormoAnalytics.init("test-write-key", {
      tracking: true,
      // High enough that nothing leaves on its own: only cleanup() can send.
      flushAt: 50,
      flushInterval: 60_000,
    } as any);
    const sent = watchWire();
    await warmUp(formo, sent);

    await formo.connect({ chainId: 1, address: ADDRESS as `0x${string}` });
    await formo.track("custom-event", { a: 1 });
    expect(delivered(sent).length, "nothing has met the batch rules yet").to.equal(1);

    formo.cleanup();
    await new Promise((r) => setTimeout(r, 20));

    expect(delivered(sent), "buffered events survive teardown").to.deep.equal([
      "custom-event",
      "connect",
      "custom-event",
    ]);
  });

  it("answers the callback of a buffered event that teardown delivered", async () => {
    const formo = await FormoAnalytics.init("test-write-key", {
      tracking: true,
      flushAt: 50,
      flushInterval: 60_000,
    } as any);
    const sent = watchWire();
    await warmUp(formo, sent);
    const answered: unknown[] = [];

    await formo.track("custom-event", { a: 1 }, undefined, (error: unknown) =>
      answered.push(error)
    );
    formo.cleanup();
    await new Promise((r) => setTimeout(r, 20));

    expect(answered.length, "the callback is answered once").to.equal(1);
    expect(answered[0], "delivered, so no error").to.be.undefined;
  });

  it("sends nothing buffered when consent was withdrawn before cleanup()", async () => {
    const formo = await FormoAnalytics.init("test-write-key", {
      tracking: true,
      flushAt: 50,
      flushInterval: 60_000,
    } as any);
    const sent = watchWire();
    await warmUp(formo, sent);

    await formo.track("custom-event", { a: 1 });
    formo.optOutTracking();
    formo.cleanup();
    await new Promise((r) => setTimeout(r, 20));

    expect(
      delivered(sent).length,
      "an opted-out visitor sends nothing more at teardown"
    ).to.equal(1);
  });

  it("releases the queue's page-leave listeners on cleanup()", async () => {
    const formo = await FormoAnalytics.init("test-write-key", { tracking: true });
    const queue = (formo as any).eventManager.eventQueue;

    formo.cleanup();

    expect(queue.isClosed).to.be.true;
    // A page-leave after teardown must not drive the dead instance's queue.
    const flush = sandbox.spy(queue, "flush");
    jsdom.window.dispatchEvent(new jsdom.window.Event("beforeunload"));
    await new Promise((r) => setTimeout(r, 5));
    expect(flush.called).to.be.false;
  });
});
