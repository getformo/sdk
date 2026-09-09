import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import { JSDOM } from "jsdom";
import { FormoAnalytics } from "../src/FormoAnalytics";
import { initStorageManager } from "../src/storage";

/** A dropped event answers its callback with an error whose code names the gate. */
describe("drop callbacks on a real instance", () => {

  let sandbox: sinon.SinonSandbox;
  let jsdom: JSDOM;
  let savedGlobals: Map<string, PropertyDescriptor | undefined>;
  let formo: FormoAnalytics | undefined;

  const GLOBAL_KEYS = [
    "window","globalThis","document","location","navigator","localStorage","sessionStorage",
    "Event","CustomEvent","addEventListener","removeEventListener","dispatchEvent","crypto",
  ] as const;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    savedGlobals = new Map(GLOBAL_KEYS.map((k) => [k, Object.getOwnPropertyDescriptor(global, k)]));
    jsdom = new JSDOM("<!DOCTYPE html><html><body></body></html>", { url: "https://example.com" });
    for (const [k, v] of [
      ["window", jsdom.window], ["globalThis", jsdom.window], ["document", jsdom.window.document],
      ["location", jsdom.window.location], ["navigator", jsdom.window.navigator],
      ["localStorage", jsdom.window.localStorage], ["sessionStorage", jsdom.window.sessionStorage],
      ["Event", jsdom.window.Event], ["CustomEvent", jsdom.window.CustomEvent],
    ] as const) {
      Object.defineProperty(global, k, { value: v, writable: true, configurable: true });
    }
    for (const fn of ["addEventListener", "removeEventListener", "dispatchEvent"] as const) {
      Object.defineProperty(global, fn, { value: (jsdom.window as any)[fn].bind(jsdom.window), writable: true, configurable: true });
    }
    Object.defineProperty(global, "crypto", { value: { randomUUID: () => "mock-uuid" }, writable: true, configurable: true });
    initStorageManager("test-write-key");
  });

  afterEach(() => {
    formo?.cleanup();
    formo = undefined;
    sandbox.restore();
    for (const [k, d] of Array.from(savedGlobals)) {
      if (d) Object.defineProperty(global, k, d);
      else delete (global as any)[k];
    }
    jsdom.window.close();
  });

  const codes = (calls: sinon.SinonStub) => calls.getCalls().map((c) => c.args[0]?.code);

  it("answers a track() callback when tracking is off, and when the visitor has opted out", async () => {
    formo = await FormoAnalytics.init("test-write-key", { tracking: false, flushAt: 1000 });
    const off = sandbox.stub();
    await formo.track("Order Placed", { market: "SOL" }, undefined, off);
    expect(codes(off)).to.deep.equal(["suppressed"]);
    formo.cleanup();

    formo = await FormoAnalytics.init("test-write-key", { tracking: true, flushAt: 1000 });
    formo.optOutTracking();
    const optedOut = sandbox.stub();
    await formo.track("Order Placed", { market: "SOL" }, undefined, optedOut);
    expect(codes(optedOut)).to.deep.equal(["suppressed"]);
    formo.optInTracking();
  });

  it("answers connect(), identify() and detect() callbacks at their own gates", async () => {
    formo = await FormoAnalytics.init("test-write-key", { tracking: true, flushAt: 1000 });
    formo.optOutTracking();
    const connect = sandbox.stub(), identify = sandbox.stub(), detect = sandbox.stub();

    await formo.connect({ chainId: 1, address: "0x51377e9B985Bb90B7c091B9a7d30C93d4c9c1CEf" }, undefined, undefined, connect);
    await formo.identify({ address: "0x51377e9B985Bb90B7c091B9a7d30C93d4c9c1CEf", userId: "u1" }, undefined, undefined, identify);
    await formo.detect({ providerName: "MetaMask", rdns: "io.metamask" }, undefined, undefined, detect);

    expect([codes(connect), codes(identify), codes(detect)]).to.deep.equal([["suppressed"], ["suppressed"], ["suppressed"]]);
    formo.optInTracking();
  });

  it("answers a track() callback when the idempotency key is invalid", async () => {
    formo = await FormoAnalytics.init("test-write-key", { tracking: true, flushAt: 1000 });
    const callback = sandbox.stub();

    await formo.track("Order Placed", { idempotency_key: "" }, undefined, callback);

    expect(codes(callback)).to.deep.equal(["invalid_key"]);
  });

  it("answers detect() and identify() callbacks for a repeat within the session", async () => {
    formo = await FormoAnalytics.init("test-write-key", { tracking: true, flushAt: 1000 });
    const first = sandbox.stub(), second = sandbox.stub();
    const rdns = `io.test.${Date.now()}`; // unseen by any earlier test's session marker
    await formo.detect({ providerName: "Test", rdns }, undefined, undefined, first);
    await formo.detect({ providerName: "Test", rdns }, undefined, undefined, second);
    expect(codes(first), "the first detect is not dropped").to.not.include("duplicate");
    expect(codes(second)).to.deep.equal(["duplicate"]);

    const id1 = sandbox.stub(), id2 = sandbox.stub();
    await formo.identify({ address: "0x51377e9B985Bb90B7c091B9a7d30C93d4c9c1CEf", userId: "u1" }, undefined, undefined, id1);
    await formo.identify({ address: "0x51377e9B985Bb90B7c091B9a7d30C93d4c9c1CEf", userId: "u1" }, undefined, undefined, id2);
    expect(codes(id2)).to.deep.equal(["duplicate"]);
  });
});
