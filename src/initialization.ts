import { FormoAnalytics } from "./FormoAnalytics";
import { IFormoAnalytics, Options } from "./types";

/**
 * The instance formofy() last created or adopted for this page, and the
 * write key it was created for. Held while init is still pending, so calls
 * in the same tick share one instance.
 *
 * Stored on the page, not in this module: a tag manager can inject the
 * bundle twice, and each copy would otherwise start its own instance
 * before the first had put anything on window.formo.
 */
type Live = {
  writeKey: string;
  promise: Promise<IFormoAnalytics>;
  /** Set once the promise resolves, so the entry can be compared with window.formo. */
  instance?: IFormoAnalytics;
};
type Registry = { live: Live | null; managed: WeakSet<IFormoAnalytics> };
const SLOT = Symbol.for("formo.live");
const SUPERSEDED = Symbol("formofy.superseded");
const registry = (): Registry => {
  const w = window as unknown as Record<symbol, Registry | Live | undefined>;
  const found = w[SLOT];
  if (found && "managed" in found) return found;
  // Nothing yet, or a slot written by an older copy that stored the live
  // entry bare (hot reload across versions): keep what it had.
  const migrated: Registry = { live: found ?? null, managed: new WeakSet() };
  if (migrated.live?.instance) migrated.managed.add(migrated.live.instance);
  w[SLOT] = migrated;
  return migrated;
};
const getLive = (): Live | null => registry().live;
const setLive = (live: Live | null): void => {
  registry().live = live;
};
/** Instances formofy created or adopted, so its own predecessor on window.formo is not mistaken for an app replacement. */
const remember = (f: IFormoAnalytics): void => {
  registry().managed.add(f);
};

/**
 * Script-tag entry point. One live instance per page:
 *
 * - A repeat call with the same write key reuses the existing instance (or
 *   the one still initialising) and only runs the new `ready` callback.
 *   Tag managers, React strict mode, and hot reloads all call this twice,
 *   and a second instance would double every autocaptured event.
 * - A call with a different write key retires the previous instance first,
 *   so only one instance ever sends.
 * - An instance the app put on `window.formo` itself is adopted the same
 *   way, matched on its write key.
 */
export function formofy(writeKey: string, options?: Options): void {
  if (!writeKey || typeof window === "undefined") {
    console.warn("FormoAnalytics not found");
    return;
  }

  const current = currentInstance();
  if (!current || current.writeKey !== writeKey) {
    start(writeKey, options, current);
    return;
  }

  setLive(current);
  if (current.instance && !isDisposed(current.instance)) {
    // Healthy and resolved: serve it now, so a key switch later in the
    // same tick cannot take the callback away.
    if (!window.formo) window.formo = current.instance;
    runReady(options, current.instance);
    return;
  }
  current.promise
    .then((f) => {
      if (!isDisposed(f)) {
        if (!window.formo) window.formo = f;
        runReady(options, f);
        return;
      }
      // The app tore it down itself. Start over, unless a newer call
      // already replaced it: a same-key restart is shared, another key wins.
      const now = getLive();
      if (now !== current) {
        if (now && now.writeKey === writeKey) {
          now.promise.then((g) => runReady(options, g)).catch(() => undefined);
        }
        return;
      }
      forgetGlobal(f);
      start(writeKey, options, null);
    })
    .catch(() => undefined);
}

/**
 * What formofy() should build on: the live entry, unless the app has since
 * put an instance of its own on window.formo, which then wins and the
 * cached one is retired so both do not send.
 */
function currentInstance(): Live | null {
  const live = getLive();
  const own = adoptWindowInstance();
  if (!live) {
    if (own) remember(own.instance!);
    return own;
  }
  if (own && own.instance !== live.instance && !registry().managed.has(own.instance!)) {
    // The app's own instance wins. A resolved cached instance is retired
    // now; a pending one retires itself on completion (see start).
    if (live.instance) retire(live.instance);
    remember(own.instance!);
    setLive(own);
    return own;
  }
  return live;
}

/** Retire `previous`, if any, then initialise a new instance and make it live. */
function start(writeKey: string, options: Options | undefined, previous: Live | null): void {
  // With nothing to retire, init runs synchronously: its constructor
  // installs the history hooks, and a navigation right after formofy()
  // must be seen.
  const entry = { writeKey } as Live;
  if (previous && !previous.instance) {
    // Still initialising: retire it once it exists, then start, unless a
    // later call took the slot while we waited.
    entry.promise = previous.promise
      .then((f) => retire(f))
      .catch(() => undefined)
      .then(() =>
        getLive() === entry
          ? FormoAnalytics.init(writeKey, options)
          : Promise.reject(SUPERSEDED)
      );
  } else {
    if (previous?.instance) retire(previous.instance);
    entry.promise = FormoAnalytics.init(writeKey, options);
  }
  const promise = entry.promise;
  setLive(entry);

  promise
    .then((f) => {
      entry.instance = f;
      remember(f);
      // Superseded while initialising (the app installed its own instance,
      // or another key took over): this result must not send.
      if (getLive() !== entry) {
        retire(f);
        return;
      }
      window.formo = f;
      runReady(options, f);
    })
    .catch((e) => {
      if (e === SUPERSEDED) return;
      // Let a later call try again rather than pin a failed init forever.
      if (getLive() === entry) setLive(null);
      console.error("Error initializing FormoAnalytics:", e);
    });
}

/** An instance the app created itself and exposed on window.formo. */
function adoptWindowInstance(): Live | null {
  const f = window.formo as (IFormoAnalytics & { writeKey?: unknown }) | undefined;
  if (!f || typeof f.writeKey !== "string") return null;
  if (isDisposed(f)) {
    forgetGlobal(f);
    return null;
  }
  return { writeKey: f.writeKey, promise: Promise.resolve(f), instance: f };
}

/** Tear an instance down and stop it being reachable as the page global. */
function retire(f: IFormoAnalytics): void {
  if (!isDisposed(f)) f.cleanup();
  forgetGlobal(f);
}

function isDisposed(f: IFormoAnalytics): boolean {
  return (f as { disposed?: boolean }).disposed === true;
}

function forgetGlobal(f: IFormoAnalytics): void {
  if (window.formo === f) delete window.formo;
}

function runReady(options: Options | undefined, f: IFormoAnalytics): void {
  if (!options?.ready) return;
  // A synchronous throw must not escape. A callback that returns a promise
  // owns its own rejections.
  try {
    options.ready(f);
  } catch (callbackError) {
    console.error("Error in FormoAnalytics ready callback:", callbackError);
  }
}

/** @internal Forget the live instance. For tests only. */
export function _resetFormofy(): void {
  if (typeof window === "undefined") return;
  const r = registry();
  r.live = null;
  r.managed = new WeakSet();
}
