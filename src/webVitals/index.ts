/**
 * Core Web Vitals (LCP, INP, CLS, FCP, TTFB), measured with
 * PerformanceObserver. The SDK takes no runtime dependency, so this follows
 * the definitions of Google's `web-vitals` library in a reduced form:
 *
 * - One report per hard page load. SPA route changes are not measured on
 *   their own; CLS and INP cover the whole life of the page, as CrUX does.
 * - The report is made when the page is first hidden (tab switch, close,
 *   navigation away). That is the point where CLS and INP are final for most
 *   visits, and the last point a browser reliably runs script.
 * - A metric the browser does not support is left out, not reported as 0.
 */

export type WebVitalsMetrics = {
  lcp?: number;
  inp?: number;
  cls?: number;
  fcp?: number;
  ttfb?: number;
};

export type WebVitalsReport = {
  metrics: WebVitalsMetrics;
  /** navigate | reload | back_forward | prerender | restore */
  navigationType: string;
  /** The URL the page was loaded with, before any SPA route change. */
  url: string;
  /** Epoch ms of the navigation start. */
  startTime: number;
};

/** Timing values above this are measurement noise, not page loads. */
const MAX_MS = 15 * 60 * 1000;
/** CLS session windows: a gap of 1 s ends a window, and a window lasts at most 5 s. */
const CLS_GAP_MS = 1000;
const CLS_WINDOW_MS = 5000;
/** Interactions shorter than this are too fast to set INP. */
const INP_DURATION_THRESHOLD = 40;
/** INP is estimated from the 10 longest interactions (the p98 when there are many). */
const INP_CANDIDATES = 10;

type Entry = PerformanceEntry & {
  hadRecentInput?: boolean;
  value?: number;
  interactionId?: number;
};

type Observed = {
  observer: PerformanceObserver;
  handle: (entries: Entry[]) => void;
};

const isSupported = (): boolean =>
  typeof window !== "undefined" &&
  typeof document !== "undefined" &&
  typeof performance !== "undefined" &&
  typeof PerformanceObserver !== "undefined";

const validMs = (value: number | undefined): number | undefined =>
  value !== undefined && Number.isFinite(value) && value >= 0 && value <= MAX_MS
    ? Math.round(value)
    : undefined;

export class WebVitalsCollector {
  private readonly observed: Observed[] = [];
  private readonly disposers: Array<() => void> = [];
  private readonly url: string;
  private readonly startTime: number;
  private readonly activationStart: number;
  private readonly navigationType: string;
  private readonly navigation?: PerformanceNavigationTiming;
  /** Time the page was first hidden. Paints after it are not the user's view. */
  private hiddenTime: number;
  private reported = false;

  private fcp?: number;
  private lcp?: number;
  private lcpFinal = false;
  private lcpObserved?: Observed;
  private clsSupported = false;
  private cls = 0;
  private clsWindowValue = 0;
  private clsWindowFirst = 0;
  private clsWindowLast = 0;
  /** interactionId -> longest duration seen for it. */
  private readonly interactions = new Map<number, number>();

  /**
   * Start measuring. Returns undefined when the browser has no
   * PerformanceObserver (old browsers, server rendering).
   */
  static start(
    onReport: (report: WebVitalsReport) => void
  ): WebVitalsCollector | undefined {
    if (!isSupported()) return undefined;
    try {
      return new WebVitalsCollector(onReport);
    } catch {
      return undefined;
    }
  }

  private constructor(
    private readonly onReport: (report: WebVitalsReport) => void
  ) {
    this.url = window.location.href;
    this.startTime =
      typeof performance.timeOrigin === "number" && performance.timeOrigin > 0
        ? performance.timeOrigin
        : Date.now() - performance.now();

    const navigation = performance.getEntriesByType?.("navigation")?.[0] as
      | PerformanceNavigationTiming
      | undefined;
    this.navigation = navigation;
    const activationStart = (navigation as { activationStart?: number } | undefined)
      ?.activationStart;
    this.activationStart =
      typeof activationStart === "number" && activationStart > 0 ? activationStart : 0;
    const doc = document as Document & { wasDiscarded?: boolean; prerendering?: boolean };
    this.navigationType = doc.wasDiscarded
      ? "restore"
      : doc.prerendering || this.activationStart > 0
        ? "prerender"
        : navigation?.type || "navigate";

    // A page loaded in a background tab has no user-visible paint to time.
    this.hiddenTime =
      document.visibilityState === "hidden" && !doc.prerendering ? 0 : Infinity;

    this.observe("paint", (entries) => this.onPaint(entries));
    this.lcpObserved = this.observe("largest-contentful-paint", (entries) =>
      this.onLargestContentfulPaint(entries)
    );
    const layoutShift = this.observe("layout-shift", (entries) =>
      this.onLayoutShift(entries)
    );
    this.clsSupported = layoutShift !== undefined;
    this.observe("event", (entries) => this.onInteraction(entries), {
      durationThreshold: INP_DURATION_THRESHOLD,
    });
    // first-input guarantees one entry for the first interaction, even when
    // it was faster than the event threshold.
    this.observe("first-input", (entries) => this.onInteraction(entries));

    // LCP stops at the first input: later paints are responses to the user,
    // not the page load.
    const onInput = () => this.finalizeLcp();
    const onVisibilityChange = () => {
      if (documentTarget.visibilityState === "hidden") this.onHidden();
    };
    const onPageHide = () => this.onHidden();
    // Captured now, not read again at removal: teardown can run after the
    // host swapped these globals, and removing from another object silently
    // leaves the listener attached.
    const windowTarget = window;
    const documentTarget = document;
    for (const type of ["keydown", "click"]) {
      windowTarget.addEventListener(type, onInput, { capture: true, once: true });
      this.disposers.push(() =>
        windowTarget.removeEventListener(type, onInput, { capture: true })
      );
    }
    documentTarget.addEventListener("visibilitychange", onVisibilityChange, true);
    windowTarget.addEventListener("pagehide", onPageHide, true);
    this.disposers.push(
      () =>
        documentTarget.removeEventListener("visibilitychange", onVisibilityChange, true),
      () => windowTarget.removeEventListener("pagehide", onPageHide, true)
    );
  }

  /** Stop measuring without reporting. */
  stop(): void {
    this.reported = true;
    for (const { observer } of this.observed) {
      try {
        observer.disconnect();
      } catch {
        // A browser that failed to observe has nothing to disconnect.
      }
    }
    this.observed.length = 0;
    for (const dispose of this.disposers) dispose();
    this.disposers.length = 0;
  }

  /** The metrics as measured so far. */
  collect(): WebVitalsMetrics {
    for (const observed of this.observed) this.drain(observed);

    const metrics: WebVitalsMetrics = {};
    const ttfb = this.ttfb();
    if (ttfb !== undefined) metrics.ttfb = ttfb;
    const fcp = validMs(this.fcp);
    if (fcp !== undefined) metrics.fcp = fcp;
    const lcp = validMs(this.lcp);
    if (lcp !== undefined) metrics.lcp = lcp;
    const inp = validMs(this.inp());
    if (inp !== undefined) metrics.inp = inp;
    // CLS is only meaningful once something was painted for the user.
    if (this.clsSupported && fcp !== undefined && Number.isFinite(this.cls)) {
      metrics.cls = Math.round(this.cls * 10000) / 10000;
    }
    return metrics;
  }

  private observe(
    type: string,
    handle: (entries: Entry[]) => void,
    options: Record<string, unknown> = {}
  ): Observed | undefined {
    try {
      if (!PerformanceObserver.supportedEntryTypes?.includes(type)) return undefined;
      const observer = new PerformanceObserver((list) =>
        handle(list.getEntries() as Entry[])
      );
      observer.observe({ type, buffered: true, ...options } as PerformanceObserverInit);
      const observed = { observer, handle };
      this.observed.push(observed);
      return observed;
    } catch {
      return undefined;
    }
  }

  /** Process entries the browser has buffered but not yet delivered. */
  private drain(observed: Observed): void {
    try {
      const pending = observed.observer.takeRecords?.() as Entry[] | undefined;
      if (pending?.length) observed.handle(pending);
    } catch {
      // takeRecords is best effort; delivered entries are already counted.
    }
  }

  private fromActivation(startTime: number): number {
    return Math.max(startTime - this.activationStart, 0);
  }

  private onPaint(entries: Entry[]): void {
    for (const entry of entries) {
      if (
        entry.name === "first-contentful-paint" &&
        this.fcp === undefined &&
        entry.startTime < this.hiddenTime
      ) {
        this.fcp = this.fromActivation(entry.startTime);
      }
    }
  }

  private onLargestContentfulPaint(entries: Entry[]): void {
    if (this.lcpFinal) return;
    for (const entry of entries) {
      if (entry.startTime < this.hiddenTime) {
        this.lcp = this.fromActivation(entry.startTime);
      }
    }
  }

  private finalizeLcp(): void {
    if (this.lcpFinal) return;
    if (this.lcpObserved) this.drain(this.lcpObserved);
    this.lcpFinal = true;
  }

  private onLayoutShift(entries: Entry[]): void {
    for (const entry of entries) {
      if (entry.hadRecentInput || typeof entry.value !== "number") continue;
      const continuesWindow =
        this.clsWindowValue > 0 &&
        entry.startTime - this.clsWindowLast < CLS_GAP_MS &&
        entry.startTime - this.clsWindowFirst < CLS_WINDOW_MS;
      if (continuesWindow) {
        this.clsWindowValue += entry.value;
        this.clsWindowLast = entry.startTime;
      } else {
        this.clsWindowValue = entry.value;
        this.clsWindowFirst = entry.startTime;
        this.clsWindowLast = entry.startTime;
      }
      this.cls = Math.max(this.cls, this.clsWindowValue);
    }
  }

  private onInteraction(entries: Entry[]): void {
    for (const entry of entries) {
      const id = entry.interactionId;
      if (!id) continue;
      const known = this.interactions.get(id);
      if (known === undefined || entry.duration > known) {
        this.interactions.set(id, entry.duration);
      }
    }
  }

  private inp(): number | undefined {
    if (this.interactions.size === 0) return undefined;
    const longest = Array.from(this.interactions.values())
      .sort((a, b) => b - a)
      .slice(0, INP_CANDIDATES);
    const counted = (performance as { interactionCount?: number }).interactionCount;
    const count =
      typeof counted === "number" && counted > 0 ? counted : this.interactions.size;
    return longest[Math.min(longest.length - 1, Math.floor(count / 50))];
  }

  private ttfb(): number | undefined {
    const responseStart = this.navigation?.responseStart;
    if (typeof responseStart !== "number" || responseStart <= 0) return undefined;
    return validMs(this.fromActivation(responseStart));
  }

  private onHidden(): void {
    if (this.reported) return;
    this.hiddenTime = Math.min(this.hiddenTime, performance.now());
    this.finalizeLcp();
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
