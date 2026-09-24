import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { JSDOM } from "jsdom";
import { WebVitalsCollector, WebVitalsReport } from "../../src/webVitals";

type FakeEntry = Record<string, unknown> & { startTime: number };

/**
 * A PerformanceObserver the test drives by hand. `emit` delivers entries the
 * way the browser does; `buffer` leaves them pending for takeRecords(), the
 * state a page is in when it is hidden before the observer callback ran.
 */
class FakeObserver {
  static supportedEntryTypes = [
    "navigation",
    "paint",
    "largest-contentful-paint",
    "layout-shift",
    "event",
    "first-input",
  ];
  static instances: FakeObserver[] = [];
  type?: string;
  options?: Record<string, unknown>;
  pending: FakeEntry[] = [];
  disconnected = false;

  constructor(private readonly callback: (list: { getEntries(): FakeEntry[] }) => void) {
    FakeObserver.instances.push(this);
  }
  observe(options: Record<string, unknown>) {
    this.type = options.type as string;
    this.options = options;
  }
  disconnect() {
    this.disconnected = true;
  }
  takeRecords() {
    const pending = this.pending;
    this.pending = [];
    return pending;
  }
  deliver(entries: FakeEntry[]) {
    this.callback({ getEntries: () => entries });
  }
}

const live = (type: string) =>
  FakeObserver.instances.filter((o) => o.type === type && !o.disconnected);
const emit = (type: string, entries: FakeEntry[]) =>
  live(type).forEach((o) => o.deliver(entries));
const buffer = (type: string, entries: FakeEntry[]) =>
  live(type).forEach((o) => o.pending.push(...entries));

describe("WebVitalsCollector", () => {
  let jsdom: JSDOM;
  let now: number;
  let navigation: Record<string, unknown> | undefined;
  let interactionCount: number | undefined;
  let reports: WebVitalsReport[];
  const saved: Record<string, PropertyDescriptor | undefined> = {};
  const TIME_ORIGIN = 1_700_000_000_000;

  const setGlobal = (name: string, value: unknown) => {
    if (!(name in saved)) saved[name] = Object.getOwnPropertyDescriptor(global, name);
    Object.defineProperty(global, name, { value, writable: true, configurable: true });
  };

  const setVisibility = (state: "visible" | "hidden") =>
    Object.defineProperty(jsdom.window.document, "visibilityState", {
      value: state,
      configurable: true,
    });

  const hide = () => {
    setVisibility("hidden");
    jsdom.window.document.dispatchEvent(new jsdom.window.Event("visibilitychange"));
  };

  const start = () => WebVitalsCollector.start((report) => reports.push(report));

  beforeEach(() => {
    jsdom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
      url: "https://example.com/landing?utm_source=x",
      pretendToBeVisual: true,
    });
    setGlobal("window", jsdom.window);
    setGlobal("document", jsdom.window.document);
    setGlobal("PerformanceObserver", FakeObserver);
    now = 10_000;
    navigation = { type: "navigate", responseStart: 120, activationStart: 0 };
    interactionCount = undefined;
    setGlobal("performance", {
      timeOrigin: TIME_ORIGIN,
      now: () => now,
      getEntriesByType: (type: string) =>
        type === "navigation" && navigation ? [navigation] : [],
      get interactionCount() {
        return interactionCount;
      },
    });
    FakeObserver.instances = [];
    reports = [];
  });

  afterEach(() => {
    for (const [name, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(global, name, descriptor);
      else delete (global as any)[name];
      delete saved[name];
    }
    jsdom.window.close();
  });

  it("reports every metric once, when the page is first hidden", () => {
    const collector = start();
    expect(collector).to.not.equal(undefined);

    emit("paint", [{ name: "first-contentful-paint", startTime: 800 }]);
    emit("largest-contentful-paint", [{ startTime: 1200 }, { startTime: 1900.4 }]);
    emit("layout-shift", [{ startTime: 1000, value: 0.05, hadRecentInput: false }]);
    emit("event", [{ startTime: 3000, duration: 180, interactionId: 1 }]);
    expect(reports).to.have.length(0);

    hide();
    // pagehide right after visibilitychange must not send a second report.
    jsdom.window.dispatchEvent(new jsdom.window.Event("pagehide"));

    expect(reports).to.have.length(1);
    expect(reports[0]).to.deep.equal({
      metrics: { ttfb: 120, fcp: 800, lcp: 1900, inp: 180, cls: 0.05 },
      navigationType: "navigate",
      url: "https://example.com/landing?utm_source=x",
      startTime: TIME_ORIGIN,
    });
  });

  it("reports on pagehide when no visibilitychange came first", () => {
    start();
    emit("paint", [{ name: "first-contentful-paint", startTime: 500 }]);
    jsdom.window.dispatchEvent(new jsdom.window.Event("pagehide"));
    expect(reports).to.have.length(1);
    expect(reports[0].metrics.fcp).to.equal(500);
  });

  it("includes entries still buffered in the observers when the page is hidden", () => {
    start();
    buffer("paint", [{ name: "first-contentful-paint", startTime: 700 }]);
    buffer("largest-contentful-paint", [{ startTime: 1500 }]);
    buffer("event", [{ startTime: 2000, duration: 90, interactionId: 4 }]);
    hide();
    expect(reports[0].metrics).to.include({ fcp: 700, lcp: 1500, inp: 90 });
  });

  it("stops LCP at the first input", () => {
    start();
    emit("largest-contentful-paint", [{ startTime: 1000 }]);
    jsdom.window.dispatchEvent(new jsdom.window.MouseEvent("click"));
    emit("largest-contentful-paint", [{ startTime: 4000 }]);
    hide();
    expect(reports[0].metrics.lcp).to.equal(1000);
  });

  it("ignores paints after the page was hidden", () => {
    start();
    emit("paint", [{ name: "first-contentful-paint", startTime: 900 }]);
    now = 2000;
    hide();
    // Delivered after the hide: too late to count, and already reported.
    emit("largest-contentful-paint", [{ startTime: 2500 }]);
    expect(reports[0].metrics).to.not.have.property("lcp");
  });

  it("takes CLS as the largest session window of shifts without recent input", () => {
    start();
    emit("paint", [{ name: "first-contentful-paint", startTime: 100 }]);
    emit("layout-shift", [
      // Window 1: two shifts less than 1 s apart.
      { startTime: 1000, value: 0.1 },
      { startTime: 1500, value: 0.12 },
      // Caused by the user: ignored.
      { startTime: 1600, value: 0.5, hadRecentInput: true },
      // Window 2: starts after a gap of more than 1 s.
      { startTime: 3000, value: 0.05 },
    ]);
    hide();
    expect(reports[0].metrics.cls).to.equal(0.22);
  });

  it("caps a CLS session window at 5 s", () => {
    start();
    emit("paint", [{ name: "first-contentful-paint", startTime: 100 }]);
    // Shifts every 900 ms: one continuous run, but a window ends at 5 s.
    const shifts = [0, 900, 1800, 2700, 3600, 4500, 5400, 6300].map((t) => ({
      startTime: 1000 + t,
      value: 0.01,
    }));
    emit("layout-shift", shifts);
    hide();
    // The first window holds the shifts at 0..4500 ms: six of them.
    expect(reports[0].metrics.cls).to.equal(0.06);
  });

  it("reports CLS as 0 when the page painted and nothing shifted", () => {
    start();
    emit("paint", [{ name: "first-contentful-paint", startTime: 100 }]);
    hide();
    expect(reports[0].metrics.cls).to.equal(0);
  });

  it("takes INP as the longest interaction, merging entries of one interaction", () => {
    start();
    emit("event", [
      { startTime: 1000, duration: 64, interactionId: 1 },
      { startTime: 1000, duration: 72, interactionId: 1 },
      { startTime: 2000, duration: 240, interactionId: 2 },
      { startTime: 3000, duration: 48, interactionId: 3 },
      // Not an interaction (no interactionId): ignored.
      { startTime: 3500, duration: 900, interactionId: 0 },
    ]);
    emit("first-input", [{ startTime: 1000, duration: 30, interactionId: 1 }]);
    hide();
    expect(reports[0].metrics.inp).to.equal(240);
  });

  it("estimates INP as the p98 when there are many interactions", () => {
    start();
    // 120 interactions on the page: skip the 2 longest (floor(120 / 50)).
    interactionCount = 120;
    emit(
      "event",
      [500, 400, 300, 200, 100].map((duration, i) => ({
        startTime: 1000 + i,
        duration,
        interactionId: i + 1,
      }))
    );
    hide();
    expect(reports[0].metrics.inp).to.equal(300);
  });

  it("observes interactions from 40 ms", () => {
    start();
    expect(live("event")[0].options).to.include({ durationThreshold: 40, buffered: true });
  });

  it("leaves out metrics the browser did not measure", () => {
    // Safari: no LCP, layout-shift or event timing.
    FakeObserver.supportedEntryTypes = ["navigation", "paint"];
    try {
      start();
      emit("paint", [{ name: "first-contentful-paint", startTime: 600 }]);
      hide();
      expect(reports[0].metrics).to.deep.equal({ ttfb: 120, fcp: 600 });
    } finally {
      FakeObserver.supportedEntryTypes = [
        "navigation",
        "paint",
        "largest-contentful-paint",
        "layout-shift",
        "event",
        "first-input",
      ];
    }
  });

  it("sends nothing when nothing was measured", () => {
    navigation = undefined;
    start();
    hide();
    expect(reports).to.have.length(0);
  });

  it("drops values that are not real page loads", () => {
    navigation = { type: "navigate", responseStart: -5 };
    start();
    emit("paint", [{ name: "first-contentful-paint", startTime: 16 * 60 * 1000 }]);
    emit("largest-contentful-paint", [{ startTime: 20 * 60 * 1000 }]);
    emit("event", [{ startTime: 1, duration: 300, interactionId: 1 }]);
    hide();
    expect(reports[0].metrics).to.deep.equal({ inp: 300 });
  });

  it("measures only TTFB for a page loaded in a background tab", () => {
    setVisibility("hidden");
    start();
    emit("paint", [{ name: "first-contentful-paint", startTime: 300 }]);
    emit("largest-contentful-paint", [{ startTime: 400 }]);
    emit("layout-shift", [{ startTime: 500, value: 0.3 }]);
    jsdom.window.dispatchEvent(new jsdom.window.Event("pagehide"));
    expect(reports[0].metrics).to.deep.equal({ ttfb: 120 });
  });

  it("times a prerendered page from its activation", () => {
    navigation = { type: "navigate", responseStart: 50, activationStart: 1000 };
    start();
    emit("paint", [{ name: "first-contentful-paint", startTime: 1300 }]);
    emit("largest-contentful-paint", [{ startTime: 1600 }]);
    hide();
    expect(reports[0].navigationType).to.equal("prerender");
    // TTFB came before activation, so it is 0 from the user's view.
    expect(reports[0].metrics).to.include({ ttfb: 0, fcp: 300, lcp: 600 });
  });

  it("reports the navigation type of a reload", () => {
    navigation = { type: "reload", responseStart: 80 };
    start();
    hide();
    expect(reports[0].navigationType).to.equal("reload");
  });

  it("stop() disconnects the observers and sends nothing", () => {
    const collector = start()!;
    emit("paint", [{ name: "first-contentful-paint", startTime: 800 }]);
    collector.stop();
    expect(FakeObserver.instances.every((o) => o.disconnected)).to.equal(true);
    hide();
    jsdom.window.dispatchEvent(new jsdom.window.Event("pagehide"));
    expect(reports).to.have.length(0);
  });

  it("does not start without PerformanceObserver", () => {
    setGlobal("PerformanceObserver", undefined);
    expect(start()).to.equal(undefined);
  });

  it("keeps a throwing reporter away from the page", () => {
    WebVitalsCollector.start(() => {
      throw new Error("reporter failed");
    });
    emit("paint", [{ name: "first-contentful-paint", startTime: 800 }]);
    expect(() => hide()).to.not.throw();
  });
});
