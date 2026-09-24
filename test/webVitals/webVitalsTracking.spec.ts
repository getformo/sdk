import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import { JSDOM } from "jsdom";
import { webcrypto } from "crypto";
import { FormoAnalytics } from "../../src/FormoAnalytics";
import { initStorageManager } from "../../src/storage";
import * as fetchModule from "../../src/fetch";

type FakeEntry = Record<string, unknown> & { startTime: number };

class FakeObserver {
  static supportedEntryTypes = ["paint", "largest-contentful-paint", "layout-shift", "event"];
  static instances: FakeObserver[] = [];
  type?: string;
  disconnected = false;
  constructor(private readonly callback: (list: { getEntries(): FakeEntry[] }) => void) {
    FakeObserver.instances.push(this);
  }
  observe(options: { type: string }) {
    this.type = options.type;
  }
  disconnect() {
    this.disconnected = true;
  }
  takeRecords() {
    return [];
  }
  deliver(entries: FakeEntry[]) {
    this.callback({ getEntries: () => entries });
  }
}

const emit = (type: string, entries: FakeEntry[]) =>
  FakeObserver.instances
    .filter((o) => o.type === type && !o.disconnected)
    .forEach((o) => o.deliver(entries));

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
  "PerformanceObserver",
];

describe("Web vitals tracking", () => {
  let sandbox: sinon.SinonSandbox;
  let jsdom: JSDOM;
  let fetchStub: sinon.SinonStub;
  const saved: Record<string, PropertyDescriptor | undefined> = {};
  const TIME_ORIGIN = Date.UTC(2026, 8, 24, 10, 0, 0);

  const setGlobal = (name: string, value: unknown) =>
    Object.defineProperty(global, name, { value, writable: true, configurable: true });

  const hide = () => {
    Object.defineProperty(jsdom.window.document, "visibilityState", {
      value: "hidden",
      configurable: true,
    });
    jsdom.window.document.dispatchEvent(new jsdom.window.Event("visibilitychange"));
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
    setGlobal("PerformanceObserver", FakeObserver);
    setGlobal("performance", {
      timeOrigin: TIME_ORIGIN,
      now: () => 5000,
      getEntriesByType: (type: string) =>
        type === "navigation" ? [{ type: "navigate", responseStart: 95 }] : [],
    });
    FakeObserver.instances = [];

    fetchStub = sandbox.stub(fetchModule, "default").resolves({
      ok: true,
      status: 200,
      statusText: "OK",
    } as Response);
    initStorageManager("test-write-key");
  });

  afterEach(() => {
    sandbox.restore();
    for (const name of GLOBALS) {
      const descriptor = saved[name];
      if (descriptor) Object.defineProperty(global, name, descriptor);
      else delete (global as any)[name];
    }
    jsdom.window.close();
  });

  it("sends one web_vitals event for the landing page when the page is hidden", async () => {
    const analytics = await FormoAnalytics.init("test-write-key", { solana: false });

    emit("paint", [{ name: "first-contentful-paint", startTime: 640 }]);
    emit("largest-contentful-paint", [{ startTime: 1310.6 }]);
    emit("event", [{ startTime: 2000, duration: 120, interactionId: 7 }]);

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

    // Sent in its own keepalive request, not left for the batch timer.
    const vitalsCall = fetchStub
      .getCalls()
      .find((call) => call.args[1].body.includes('"web_vitals"'))!;
    expect(vitalsCall.args[1].keepalive).to.equal(true);

    analytics.cleanup();
  });

  it("does not measure when autocapture.webVitals is false", async () => {
    await FormoAnalytics.init("test-write-key", {
      solana: false,
      autocapture: { webVitals: false },
    });
    expect(FakeObserver.instances).to.have.length(0);
  });

  it("does not measure when autocapture is false", async () => {
    await FormoAnalytics.init("test-write-key", { solana: false, autocapture: false });
    expect(FakeObserver.instances).to.have.length(0);
  });

  it("does not send when web vitals are turned off after init", async () => {
    const analytics = await FormoAnalytics.init("test-write-key", { solana: false });
    const addEvent = sandbox.stub((analytics as any).eventManager, "addEvent").resolves();
    emit("paint", [{ name: "first-contentful-paint", startTime: 640 }]);

    analytics.options.autocapture = { webVitals: false };
    hide();
    await new Promise((r) => setTimeout(r, 20));

    expect(addEvent.getCalls().map((c) => (c.args[0] as any).type)).to.not.include(
      "web_vitals"
    );
  });

  it("does not send for a visitor who opted out", async () => {
    const analytics = await FormoAnalytics.init("test-write-key", { solana: false });
    const addEvent = sandbox.stub((analytics as any).eventManager, "addEvent").resolves();
    emit("paint", [{ name: "first-contentful-paint", startTime: 640 }]);

    analytics.optOutTracking();
    hide();
    await new Promise((r) => setTimeout(r, 20));

    expect(addEvent.getCalls().map((c) => (c.args[0] as any).type)).to.not.include(
      "web_vitals"
    );
  });

  it("cleanup() stops measuring", async () => {
    const analytics = await FormoAnalytics.init("test-write-key", { solana: false });
    expect(FakeObserver.instances.length).to.be.greaterThan(0);
    analytics.cleanup();
    expect(FakeObserver.instances.every((o) => o.disconnected)).to.equal(true);
  });
});
