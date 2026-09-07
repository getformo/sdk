import { FormoAnalytics } from "./FormoAnalytics";
import { IFormoAnalytics, Options } from "./types";

/**
 * The instance formofy() last created or adopted for this page, and the
 * write key it was created for. Kept while init is still pending, so two
 * calls in the same tick share one instance too.
 */
type LiveInstance = { writeKey: string; promise: Promise<IFormoAnalytics> };
let live: LiveInstance | null = null;

function runReady(options: Options | undefined, instance: IFormoAnalytics): void {
  if (!options?.ready) return;
  // Wrap the callback so a synchronous throw cannot escape. A callback that
  // returns a promise owns its own rejections.
  try {
    options.ready(instance);
  } catch (callbackError) {
    console.error("Error in FormoAnalytics ready callback:", callbackError);
  }
}

/**
 * Script-tag entry point. One live instance per page:
 *
 * - A repeat call with the same write key reuses the existing instance (or
 *   the one still initialising) and only runs the new `ready` callback.
 *   Tag managers, React strict mode, and hot reloads all call this twice,
 *   and a second instance would double every autocaptured event.
 * - A call with a different write key tears the previous instance down
 *   first, so only one instance ever sends.
 * - An instance the app put on `window.formo` itself is adopted the same
 *   way, matched on its write key.
 */
export function formofy(writeKey: string, options?: Options) {
  if (!writeKey || typeof window === "undefined") {
    console.warn("FormoAnalytics not found");
    return;
  }

  const existing = live ?? (live = adoptWindowInstance());
  if (existing && existing.writeKey === writeKey) {
    existing.promise
      .then((f) => {
        if (!isDisposed(f)) {
          runReady(options, f);
          return;
        }
        // The app tore it down itself. Forget it and start over.
        if (live === existing) live = null;
        forgetGlobal(f);
        formofy(writeKey, options);
      })
      .catch(() => undefined);
    return;
  }

  const previous: Promise<IFormoAnalytics | null> = existing?.promise ?? Promise.resolve(null);
  const promise = previous
    .then((f) => {
      if (f && !isDisposed(f)) f.cleanup();
      if (f) forgetGlobal(f);
    })
    .catch(() => undefined)
    .then(() => FormoAnalytics.init(writeKey, options));
  const entry: LiveInstance = { writeKey, promise };
  live = entry;

  promise
    .then((f) => {
      window.formo = f;
      runReady(options, f);
    })
    .catch((e) => {
      // Let a later call try again rather than pin a failed init forever.
      if (live === entry) live = null;
      console.error("Error initializing FormoAnalytics:", e);
    });
}

/** An instance the app created itself and exposed on window.formo. */
function adoptWindowInstance(): LiveInstance | null {
  const f = window.formo as (IFormoAnalytics & { writeKey?: unknown }) | undefined;
  if (!f || typeof f.writeKey !== "string" || isDisposed(f)) return null;
  return { writeKey: f.writeKey, promise: Promise.resolve(f) };
}

function isDisposed(f: IFormoAnalytics): boolean {
  return (f as { disposed?: boolean }).disposed === true;
}

/** A torn-down instance must not stay reachable as the page global. */
function forgetGlobal(f: IFormoAnalytics): void {
  if (window.formo === f) delete window.formo;
}

/** @internal Forget the live instance. For tests only. */
export function _resetFormofy(): void {
  live = null;
}
