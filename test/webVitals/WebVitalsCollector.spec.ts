import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { JSDOM } from "jsdom";
import {
  WebVitalsCollector,
  WebVitalsMetric,
  WebVitalsReport,
  isWebVitalsLibrary,
} from "../../src/webVitals";

type Callback = (metric: WebVitalsMetric) => void;

/**
 * A stand-in for the `web-vitals` module. `report` delivers a metric the way
 * the library does. `reportOnHidden` queues a final report the library makes
 * in its own hidden listener, which it adds on window in the capture phase.
 */
const fakeLibrary = (win: Window, names = ["LCP", "INP", "CLS", "FCP", "TTFB"]) => {
  const callbacks: Record<string, Callback> = {};
  const onHidden: Array<() => void> = [];
  const library: Record<string, unknown> = {};
  for (const name of names) {
    library[`on${name}`] = (cb: Callback) => {
      callbacks[name] = cb;
    };
  }
  win.addEventListener(
    "visibilitychange",
    () => {
      if (win.document.visibilityState === "hidden") onHidden.forEach((f) => f());
    },
    true
  );
  const report = (name: string, value: number, extra: Partial<WebVitalsMetric> = {}) =>
    callbacks[name]?.({ name, value, navigationType: "navigate", ...extra });
  const reportOnHidden = (name: string, value: number) =>
    onHidden.push(() => report(name, value));
  return { library, report, reportOnHidden };
};

describe("WebVitalsCollector", () => {
  let jsdom: JSDOM;
  let reports: WebVitalsReport[];
  const saved: Record<string, PropertyDescriptor | undefined> = {};
  const TIME_ORIGIN = 1_700_000_000_000;

  const setGlobal = (name: string, value: unknown) => {
    if (!(name in saved)) saved[name] = Object.getOwnPropertyDescriptor(global, name);
    Object.defineProperty(global, name, { value, writable: true, configurable: true });
  };

  const hide = () => {
    Object.defineProperty(jsdom.window.document, "visibilityState", {
      value: "hidden",
      configurable: true,
    });
    jsdom.window.document.dispatchEvent(
      new jsdom.window.Event("visibilitychange", { bubbles: true })
    );
  };

  const start = (library: unknown) =>
    WebVitalsCollector.start(library, (report) => reports.push(report));

  beforeEach(() => {
    jsdom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
      url: "https://example.com/landing?utm_source=x",
      pretendToBeVisual: true,
    });
    setGlobal("window", jsdom.window);
    setGlobal("document", jsdom.window.document);
    setGlobal("performance", { timeOrigin: TIME_ORIGIN, now: () => 1000 });
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

  it("sends every metric once, when the page is first hidden", () => {
    const lib = fakeLibrary(jsdom.window as unknown as Window);
    start(lib.library);

    lib.report("TTFB", 120.4);
    lib.report("FCP", 800);
    lib.report("LCP", 1900.6);
    expect(reports).to.have.length(0);

    hide();
    jsdom.window.dispatchEvent(new jsdom.window.Event("pagehide"));

    expect(reports).to.deep.equal([
      {
        metrics: { ttfb: 120, fcp: 800, lcp: 1901 },
        navigationType: "navigate",
        url: "https://example.com/landing?utm_source=x",
        startTime: TIME_ORIGIN,
      },
    ]);
  });

  it("includes the reports the library makes as the page is hidden", () => {
    // The library finalizes CLS and INP in its own hidden listener. It must
    // run before ours, or they would be missing from every report.
    const lib = fakeLibrary(jsdom.window as unknown as Window);
    start(lib.library);
    lib.report("FCP", 700);
    lib.reportOnHidden("CLS", 0.12345);
    lib.reportOnHidden("INP", 184);

    hide();

    expect(reports[0].metrics).to.deep.equal({ fcp: 700, cls: 0.1235, inp: 184 });
  });

  it("sends before the page-leave flush, a document listener", () => {
    const order: string[] = [];
    const lib = fakeLibrary(jsdom.window as unknown as Window);
    WebVitalsCollector.start(lib.library, () => order.push("report"));
    // EventQueue's page-leave flush listens on document.
    jsdom.window.document.addEventListener("visibilitychange", () => order.push("flush"));
    lib.report("FCP", 700);

    hide();

    expect(order).to.deep.equal(["report", "flush"]);
  });

  it("sends when visibilitychange does not bubble", () => {
    const lib = fakeLibrary(jsdom.window as unknown as Window);
    start(lib.library);
    lib.report("FCP", 700);
    Object.defineProperty(jsdom.window.document, "visibilityState", {
      value: "hidden",
      configurable: true,
    });
    jsdom.window.document.dispatchEvent(new jsdom.window.Event("visibilitychange"));
    expect(reports).to.have.length(1);
  });

  it("sends on pagehide when no visibilitychange came first", () => {
    const lib = fakeLibrary(jsdom.window as unknown as Window);
    start(lib.library);
    lib.report("FCP", 500);
    jsdom.window.dispatchEvent(new jsdom.window.Event("pagehide"));
    expect(reports).to.have.length(1);
    expect(reports[0].metrics).to.deep.equal({ fcp: 500 });
  });

  it("keeps the latest value of a metric", () => {
    const lib = fakeLibrary(jsdom.window as unknown as Window);
    start(lib.library);
    lib.report("LCP", 1000);
    lib.report("LCP", 1400);
    hide();
    expect(reports[0].metrics.lcp).to.equal(1400);
  });

  it("takes the URL and navigation type from the library", () => {
    const lib = fakeLibrary(jsdom.window as unknown as Window);
    start(lib.library);
    lib.report("TTFB", 50, {
      navigationType: "reload",
      navigationURL: "https://example.com/first",
    });
    hide();
    expect(reports[0].url).to.equal("https://example.com/first");
    expect(reports[0].navigationType).to.equal("reload");
  });

  it("ignores reports for a back/forward cache restore or a soft navigation", () => {
    const lib = fakeLibrary(jsdom.window as unknown as Window);
    start(lib.library);
    lib.report("FCP", 900);
    lib.report("LCP", 3, { navigationType: "back-forward-cache" });
    lib.report("INP", 40, { navigationType: "soft-navigation" });
    hide();
    expect(reports[0].metrics).to.deep.equal({ fcp: 900 });
    expect(reports[0].navigationType).to.equal("navigate");
  });

  it("drops values that are not real page loads", () => {
    const lib = fakeLibrary(jsdom.window as unknown as Window);
    start(lib.library);
    lib.report("TTFB", -5);
    lib.report("FCP", 16 * 60 * 1000);
    lib.report("LCP", NaN);
    lib.report("INP", 300);
    hide();
    expect(reports[0].metrics).to.deep.equal({ inp: 300 });
  });

  it("keeps CLS of 0", () => {
    const lib = fakeLibrary(jsdom.window as unknown as Window);
    start(lib.library);
    lib.report("CLS", 0);
    hide();
    expect(reports[0].metrics).to.deep.equal({ cls: 0 });
  });

  it("ignores metrics it does not know", () => {
    let callback: Callback = () => {};
    start({ onFCP: (cb: Callback) => (callback = cb) });
    callback({ name: "FCP", value: 400 });
    // A metric the SDK has no property for, e.g. the retired FID.
    callback({ name: "FID", value: 12 });
    hide();
    expect(reports[0].metrics).to.deep.equal({ fcp: 400 });
  });

  it("sends nothing when nothing was measured", () => {
    const lib = fakeLibrary(jsdom.window as unknown as Window);
    start(lib.library);
    hide();
    expect(reports).to.have.length(0);
  });

  it("works with a partial library, and when one metric fails to start", () => {
    const lib = fakeLibrary(jsdom.window as unknown as Window, ["FCP", "TTFB"]);
    lib.library.onINP = () => {
      throw new Error("PerformanceEventTiming is not supported");
    };
    start(lib.library);
    lib.report("FCP", 600);
    lib.report("TTFB", 90);
    hide();
    expect(reports[0].metrics).to.deep.equal({ fcp: 600, ttfb: 90 });
  });

  it("does not start without the library", () => {
    expect(start(undefined)).to.equal(undefined);
    expect(start(true)).to.equal(undefined);
    expect(start({ onLCP: "no" })).to.equal(undefined);
    expect(isWebVitalsLibrary({ onTTFB: () => {} })).to.equal(true);
  });

  it("stop() removes its listeners and ignores later reports", () => {
    const lib = fakeLibrary(jsdom.window as unknown as Window);
    const collector = start(lib.library)!;
    lib.report("FCP", 800);
    collector.stop();
    lib.report("LCP", 900);
    hide();
    jsdom.window.dispatchEvent(new jsdom.window.Event("pagehide"));
    expect(reports).to.have.length(0);
  });

  it("keeps a throwing reporter away from the page", () => {
    const lib = fakeLibrary(jsdom.window as unknown as Window);
    WebVitalsCollector.start(lib.library, () => {
      throw new Error("reporter failed");
    });
    lib.report("FCP", 800);
    expect(() => hide()).to.not.throw();
  });
});
