import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import { JSDOM } from "jsdom";
import { webcrypto } from "crypto";
import { FormoAnalytics } from "../../src/FormoAnalytics";
import { initStorageManager } from "../../src/storage";
import * as fetchModule from "../../src/fetch";
import * as browsers from "../../src/browser/browsers";
import { logger } from "../../src/logger";

type Callback = (metric: { name: string; value: number; navigationType?: string }) => void;

/** A stand-in for the `web-vitals` module, driven by `report`. */
let callbacks: Record<string, Callback> = {};
const fakeLibrary = () => {
  callbacks = {};
  const library: Record<string, (cb: Callback) => void> = {};
  for (const name of ["LCP", "INP", "CLS", "FCP", "TTFB"]) {
    library[`on${name}`] = (cb) => {
      callbacks[name] = cb;
    };
  }
  return library;
};
const report = (name: string, value: number) =>
  callbacks[name]?.({ name, value, navigationType: "navigate" });

const GLOBALS = [
  "window",
  "document",
  "location",
  "globalThis",
  "navigator",
  "localStorage",
  "sessionStorage",
  "crypto",
  "history",
  "performance",
];

describe("Web vitals tracking", () => {
  let sandbox: sinon.SinonSandbox;
  let jsdom: JSDOM;
  let fetchStub: sinon.SinonStub;
  const saved: Record<string, PropertyDescriptor | undefined> = {};
  const TIME_ORIGIN = Date.UTC(2026, 8, 24, 10, 0, 0);
  let instances: FormoAnalytics[] = [];
  const init = async (
    options: Parameters<typeof FormoAnalytics.init>[1]
  ): Promise<FormoAnalytics> => {
    const instance = await FormoAnalytics.init("test-write-key", options);
    instances.push(instance);
    return instance;
  };

  const setGlobal = (name: string, value: unknown) =>
    Object.defineProperty(global, name, { value, writable: true, configurable: true });

  const hide = () => {
    Object.defineProperty(jsdom.window.document, "visibilityState", {
      value: "hidden",
      configurable: true,
    });
    // Browsers fire it at document with bubbles set (HTML spec).
    jsdom.window.document.dispatchEvent(
      new jsdom.window.Event("visibilitychange", { bubbles: true })
    );
  };

  const sentEvents = () =>
    fetchStub
      .getCalls()
      .flatMap((call) => JSON.parse(call.args[1].body) as Array<Record<string, any>>);

  const waitFor = async (predicate: () => boolean, ms = 2000) => {
    const until = Date.now() + ms;
    while (!predicate() && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    for (const name of GLOBALS) saved[name] = Object.getOwnPropertyDescriptor(global, name);

    jsdom = new JSDOM("<!DOCTYPE html><html><head><title>Landing</title></head><body></body></html>", {
      url: "https://example.com/landing?privy_oauth_code=secret&ref=abc",
      pretendToBeVisual: true,
    });
    setGlobal("window", jsdom.window);
    setGlobal("document", jsdom.window.document);
    setGlobal("location", jsdom.window.location);
    setGlobal("globalThis", jsdom.window);
    setGlobal("navigator", jsdom.window.navigator);
    setGlobal("localStorage", jsdom.window.localStorage);
    setGlobal("sessionStorage", jsdom.window.sessionStorage);
    setGlobal("crypto", webcrypto);
    setGlobal("history", jsdom.window.history);
    setGlobal("performance", { timeOrigin: TIME_ORIGIN, now: () => 5000 });
    callbacks = {};

    fetchStub = sandbox.stub(fetchModule, "default").resolves({
      ok: true,
      status: 200,
      statusText: "OK",
    } as Response);
    initStorageManager("test-write-key");
  });

  afterEach(() => {
    // Before the globals go: a live instance's 300 ms page-hit timer must
    // not run against the next test's environment.
    instances.forEach((instance) => instance.cleanup());
    instances = [];
    sandbox.restore();
    for (const name of GLOBALS) {
      const descriptor = saved[name];
      if (descriptor) Object.defineProperty(global, name, descriptor);
      else delete (global as any)[name];
    }
    jsdom.window.close();
  });

  it("sends one web_vitals event for the landing page when the page is hidden", async () => {
    const analytics = await init({
      solana: false,
      webVitals: fakeLibrary(),
    });

    report("TTFB", 95);
    report("FCP", 640);
    report("LCP", 1310.6);
    report("INP", 120);
    report("CLS", 0);

    // An SPA route change after the load: the report still describes /landing.
    jsdom.window.history.pushState({}, "", "/dashboard");
    // trackPageHit waits 300 ms before it emits the page event.
    await new Promise((r) => setTimeout(r, 350));

    hide();
    await waitFor(() => sentEvents().some((e) => e.type === "web_vitals"));

    const vitals = sentEvents().filter((e) => e.type === "web_vitals");
    expect(vitals).to.have.length(1);
    const [event] = vitals;
    expect(event.properties).to.deep.equal({
      ttfb: 95,
      fcp: 640,
      lcp: 1311,
      inp: 120,
      cls: 0,
      navigation_type: "navigate",
    });
    // The built-in denylist strips the OAuth code from the landing URL.
    expect(event.context.page_url).to.equal("https://example.com/landing?ref=abc");
    expect(event.original_timestamp).to.equal(new Date(TIME_ORIGIN).toISOString());
    expect(event.event).to.equal(null);

    // The route change was tracked as a page view of its own.
    const pages = sentEvents().filter((e) => e.type === "page");
    expect(pages.map((e) => e.properties.path)).to.include("/dashboard");

    // Sent in a keepalive request, not left for the batch timer. (With a
    // browser-dispatched event it shares the page-leave request; an event
    // dispatched from script runs microtasks only after every listener, so
    // that is checked in a real browser, not here.)
    const vitalsCall = fetchStub
      .getCalls()
      .find((call) => call.args[1].body.includes('"web_vitals"'))!;
    expect(vitalsCall.args[1].keepalive).to.equal(true);

    analytics.cleanup();
  });

  it("starts browser detection as soon as it measures, not at page leave", async () => {
    const detect = sandbox.stub(browsers, "detectBrowser").resolves("chrome");
    await init({ solana: false, webVitals: fakeLibrary() });
    // Right after init: before the 300 ms page hit and before any page leave.
    expect(detect.called).to.equal(true);
  });

  it("does not start browser detection early without the library", async () => {
    const detect = sandbox.stub(browsers, "detectBrowser").resolves("chrome");
    await init({ solana: false });
    expect(detect.called).to.equal(false);
  });

  it("does not measure without the library (opt-in)", async () => {
    const analytics = await init({ solana: false });
    expect((analytics as any).webVitals).to.equal(undefined);
  });

  it("warns and does not measure when webVitals is not the library", async () => {
    const warn = sandbox.stub(logger, "warn");
    const analytics = await init({
      solana: false,
      webVitals: true as any,
    });
    expect((analytics as any).webVitals).to.equal(undefined);
    expect(warn.getCalls().some((c) => String(c.args[0]).includes("webVitals"))).to.equal(true);
  });

  it("measures even when wallet autocapture is off", async () => {
    const analytics = await init({
      solana: false,
      autocapture: false,
      webVitals: fakeLibrary(),
    });
    expect((analytics as any).webVitals).to.not.equal(undefined);
  });

  it("does not send when webVitals is removed after init", async () => {
    const analytics = await init({
      solana: false,
      webVitals: fakeLibrary(),
    });
    const addEvent = sandbox.stub((analytics as any).eventManager, "addEvent").resolves();
    report("FCP", 640);

    analytics.options.webVitals = undefined;
    hide();
    await new Promise((r) => setTimeout(r, 20));

    expect(addEvent.getCalls().map((c) => (c.args[0] as any).type)).to.not.include(
      "web_vitals"
    );
  });

  it("does not send for a visitor who opted out", async () => {
    const analytics = await init({
      solana: false,
      webVitals: fakeLibrary(),
    });
    const addEvent = sandbox.stub((analytics as any).eventManager, "addEvent").resolves();
    report("FCP", 640);

    analytics.optOutTracking();
    hide();
    await new Promise((r) => setTimeout(r, 20));

    expect(addEvent.getCalls().map((c) => (c.args[0] as any).type)).to.not.include(
      "web_vitals"
    );
  });

  it("does not send measurements from before an opt-out, even after opting back in", async () => {
    const analytics = await init({ solana: false, webVitals: fakeLibrary() });
    const addEvent = sandbox.stub((analytics as any).eventManager, "addEvent").resolves();
    report("FCP", 640);

    analytics.optOutTracking();
    analytics.optInTracking();
    report("LCP", 900);
    hide();
    await new Promise((r) => setTimeout(r, 20));

    expect(addEvent.getCalls().map((c) => (c.args[0] as any).type)).to.not.include(
      "web_vitals"
    );
  });

  it("does not measure for a visitor who opted out before init", async () => {
    const first = await init({ solana: false });
    first.optOutTracking();
    first.cleanup();

    const analytics = await init({ solana: false, webVitals: fakeLibrary() });
    expect((analytics as any).webVitals).to.equal(undefined);
    // Opting in later on this page load does not start measuring either.
    analytics.optInTracking();
    expect((analytics as any).webVitals).to.equal(undefined);
  });

  it("applies path exclusions to the landing page, not the current route", async () => {
    const analytics = await init({
      solana: false,
      webVitals: fakeLibrary(),
      tracking: { excludePaths: ["/landing"] },
    });
    const addEvent = sandbox.stub((analytics as any).eventManager, "addEvent").resolves();
    report("FCP", 640);

    // The SPA moves to an allowed route before the page is hidden.
    jsdom.window.history.pushState({}, "", "/dashboard");
    hide();
    await new Promise((r) => setTimeout(r, 20));

    expect(addEvent.getCalls().map((c) => (c.args[0] as any).type)).to.not.include(
      "web_vitals"
    );
  });

  it("sends for an allowed landing page after a move to an excluded route", async () => {
    const analytics = await init({
      solana: false,
      webVitals: fakeLibrary(),
      tracking: { excludePaths: ["/private"] },
    });
    const addEvent = sandbox.stub((analytics as any).eventManager, "addEvent").resolves();
    report("FCP", 640);

    jsdom.window.history.pushState({}, "", "/private");
    hide();
    await new Promise((r) => setTimeout(r, 20));

    expect(addEvent.getCalls().map((c) => (c.args[0] as any).type)).to.include("web_vitals");
  });

  it("cleanup() stops measuring", async () => {
    const analytics = await init({
      solana: false,
      webVitals: fakeLibrary(),
    });
    const addEvent = sandbox.stub((analytics as any).eventManager, "addEvent").resolves();
    report("FCP", 640);
    analytics.cleanup();
    hide();
    await new Promise((r) => setTimeout(r, 20));
    expect(addEvent.called).to.equal(false);
  });
});
