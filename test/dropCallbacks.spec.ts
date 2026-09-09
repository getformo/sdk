import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import { JSDOM } from "jsdom";
import { FormoAnalytics } from "../src/FormoAnalytics";
import { initStorageManager } from "../src/storage";

/**
 * A Wallet Standard wallet injected before the SDK is reported the moment
 * discovery starts. The persisted snapshot must already be in place by then,
 * so the live connection lands on top of it and not under it.
 */
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

  it("answers a track() callback when tracking is off", async () => {
    formo = await FormoAnalytics.init("test-write-key", { tracking: false, flushAt: 1000 });
    const callback = sandbox.stub();

    await formo.track("Order Placed", { market: "SOL" }, undefined, callback);

    expect(codes(callback)).to.deep.equal(["suppressed"]);
  });

  it("answers a track() callback when the visitor has opted out", async () => {
    formo = await FormoAnalytics.init("test-write-key", { tracking: true, flushAt: 1000 });
    formo.optOutTracking();
    const callback = sandbox.stub();

    await formo.track("Order Placed", { market: "SOL" }, undefined, callback);

    expect(codes(callback)).to.deep.equal(["suppressed"]);
    formo.optInTracking();
  });
});
