/**
 * Core Web Vitals, measured by Google's `web-vitals` library. The SDK does
 * not depend on the library: the app passes it in (`webVitals` option), so
 * web vitals are opt-in and cost nothing for apps that do not use them.
 * Only the shape below is read, so any 4.x to 6.x build works, including
 * the IIFE build's `window.webVitals`.
 *
 * - One report per hard page load, sent when the page is first hidden (tab
 *   switch, close, navigation away). The library makes its final CLS, INP
 *   and LCP reports in its own `visibilitychange` listener, which runs
 *   before ours: it listens on `window` in the capture phase, we listen on
 *   `document`, and ours is added after the library's.
 * - SPA route changes and back/forward cache restores are not reported on
 *   their own; CLS and INP cover the whole life of the page, as CrUX does.
 * - A metric the browser does not support is left out, not reported as 0.
 */

/** The fields of a `web-vitals` Metric that the SDK reads. */
export type WebVitalsMetric = {
  name: string;
  value: number;
  navigationType?: string;
  navigationURL?: string;
};

type OnMetric = (
  onReport: (metric: WebVitalsMetric) => void,
  opts?: Record<string, unknown>
) => unknown;

/** The `web-vitals` module, or any object with its `on*` functions. */
export type WebVitalsLibrary = {
  onLCP?: OnMetric;
  onINP?: OnMetric;
  onCLS?: OnMetric;
  onFCP?: OnMetric;
  onTTFB?: OnMetric;
};

export type WebVitalsMetrics = {
  lcp?: number;
  inp?: number;
  cls?: number;
  fcp?: number;
  ttfb?: number;
};

export type WebVitalsReport = {
  metrics: WebVitalsMetrics;
  /** The library's navigationType: navigate, reload, back-forward, prerender, restore. */
  navigationType: string;
  /** The URL the page was loaded with, before any SPA route change. */
  url: string;
  /** Epoch ms of the navigation start. */
  startTime: number;
};

const METRICS = ["LCP", "INP", "CLS", "FCP", "TTFB"] as const;

/** Timing values above this are measurement noise, not page loads. */
const MAX_MS = 15 * 60 * 1000;

/**
 * Reports for a later navigation of the same document. The hard load was
 * already reported, and a restore from the back/forward cache is near
 * instant, so counting it would pull every percentile towards "good".
 */
const LATER_NAVIGATIONS = new Set(["back-forward-cache", "soft-navigation"]);

/** True when `value` has at least one of the library's `on*` functions. */
export const isWebVitalsLibrary = (value: unknown): value is WebVitalsLibrary =>
  value !== null &&
  (typeof value === "object" || typeof value === "function") &&
  METRICS.some(
    (name) => typeof (value as Record<string, unknown>)[`on${name}`] === "function"
  );

const toValue = (name: string, value: number): number | undefined => {
  if (!Number.isFinite(value) || value < 0) return undefined;
  if (name === "CLS") return Math.round(value * 10000) / 10000;
  return value <= MAX_MS ? Math.round(value) : undefined;
};

export class WebVitalsCollector {
  private readonly metrics: WebVitalsMetrics = {};
  private readonly disposers: Array<() => void> = [];
  private readonly startTime: number;
  private url: string;
  private navigationType = "navigate";
  private reported = false;

  /**
   * Start measuring with the library the app passed in. Returns undefined
   * when there is nothing to measure with (no library, no browser).
   */
  static start(
    library: unknown,
    onReport: (report: WebVitalsReport) => void
  ): WebVitalsCollector | undefined {
    if (
      !isWebVitalsLibrary(library) ||
      typeof window === "undefined" ||
      typeof document === "undefined"
    ) {
      return undefined;
    }
    try {
      return new WebVitalsCollector(library, onReport);
    } catch {
      return undefined;
    }
  }

  private constructor(
    library: WebVitalsLibrary,
    private readonly onReport: (report: WebVitalsReport) => void
  ) {
    this.url = window.location.href;
    const origin = typeof performance !== "undefined" ? performance.timeOrigin : undefined;
    this.startTime =
      typeof origin === "number" && origin > 0 ? origin : Date.now();

    for (const name of METRICS) {
      const on = library[`on${name}`];
      if (typeof on !== "function") continue;
      try {
        on((metric) => this.onMetric(metric));
      } catch {
        // One metric the browser cannot measure must not stop the others.
      }
    }

    // Added after the library's listeners, so its final reports are in.
    // Captured now, not read again at removal: teardown can run after the
    // host swapped these globals, and removing from another object silently
    // leaves the listener attached.
    const windowTarget = window;
    const documentTarget = document;
    const onVisibilityChange = () => {
      if (documentTarget.visibilityState === "hidden") this.send();
    };
    const onPageHide = () => this.send();
    documentTarget.addEventListener("visibilitychange", onVisibilityChange);
    windowTarget.addEventListener("pagehide", onPageHide);
    this.disposers.push(
      () => documentTarget.removeEventListener("visibilitychange", onVisibilityChange),
      () => windowTarget.removeEventListener("pagehide", onPageHide)
    );
  }

  /** Stop without reporting. The library keeps its observers; its reports are ignored. */
  stop(): void {
    this.reported = true;
    for (const dispose of this.disposers) dispose();
    this.disposers.length = 0;
  }

  /** The metrics as reported so far. */
  collect(): WebVitalsMetrics {
    return { ...this.metrics };
  }

  private onMetric(metric: WebVitalsMetric): void {
    if (this.reported || !metric || typeof metric.name !== "string") return;
    if (metric.navigationType && LATER_NAVIGATIONS.has(metric.navigationType)) return;
    if (!(METRICS as readonly string[]).includes(metric.name)) return;
    const value = toValue(metric.name, metric.value);
    if (value === undefined) return;
    this.metrics[metric.name.toLowerCase() as keyof WebVitalsMetrics] = value;
    if (metric.navigationType) this.navigationType = metric.navigationType;
    // The navigation entry's URL: the page as loaded, whatever the SDK saw.
    if (typeof metric.navigationURL === "string" && metric.navigationURL) {
      this.url = metric.navigationURL;
    }
  }

  private send(): void {
    if (this.reported) return;
    const metrics = this.collect();
    this.stop();
    if (Object.keys(metrics).length === 0) return;
    try {
      this.onReport({
        metrics,
        navigationType: this.navigationType,
        url: this.url,
        startTime: this.startTime,
      });
    } catch {
      // A failing reporter must not break the host page's unload.
    }
  }
}
