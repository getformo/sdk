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
type Live = { writeKey: string; promise: Promise<IFormoAnalytics> };
const SLOT = Symbol.for("formo.live");
const slot = () => window as unknown as Record<symbol, Live | undefined>;
const getLive = (): Live | null => slot()[SLOT] ?? null;
const setLive = (live: Live | null): void => {
  slot()[SLOT] = live ?? undefined;
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

  const current = getLive() ?? adoptWindowInstance();
  if (!current || current.writeKey !== writeKey) {
    start(writeKey, options, current);
    return;
  }

  setLive(current);
  current.promise
    .then((f) => {
      if (!isDisposed(f)) {
        runReady(options, f);
        return;
      }
      // The app tore it down itself. Start over, unless a newer call
      // already replaced it, in which case that call wins.
      if (getLive() !== current) return;
      forgetGlobal(f);
      start(writeKey, options, null);
    })
    .catch(() => undefined);
}

/** Retire `previous`, if any, then initialise a new instance and make it live. */
function start(writeKey: string, options: Options | undefined, previous: Live | null): void {
  const promise = (previous?.promise ?? Promise.resolve(null))
    .then((f) => f && retire(f))
    .catch(() => undefined)
    .then(() => FormoAnalytics.init(writeKey, options));
  const entry: Live = { writeKey, promise };
  setLive(entry);

  promise
    .then((f) => {
      window.formo = f;
      runReady(options, f);
    })
    .catch((e) => {
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
  return { writeKey: f.writeKey, promise: Promise.resolve(f) };
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
  if (typeof window !== "undefined") setLive(null);
}
