import { REPLAY_SCRIPT_INTEGRITY, REPLAY_SCRIPT_URL } from "./constants";
import { RecordFn } from "./types";

declare global {
  interface Window {
    rrwebRecord?: { record?: RecordFn } | RecordFn;
  }
}

const pending = new Map<string, Promise<RecordFn>>();

/** The UMD build exposes its module exports as `window.rrwebRecord`. */
function readGlobalRecord(): RecordFn | undefined {
  const global = typeof window !== "undefined" ? window.rrwebRecord : undefined;
  if (!global) return undefined;
  if (typeof global === "function") return global;
  return typeof global.record === "function" ? global.record : undefined;
}

/**
 * Load the rrweb recorder with a script tag, once per URL per page.
 *
 * The default URL is pinned and checked with subresource integrity, so a
 * compromised CDN cannot run other code on the customer's page. A custom
 * `scriptUrl` is the customer's own file and is loaded as given.
 */
export function loadRecorder(scriptUrl?: string): Promise<RecordFn> {
  const existing = readGlobalRecord();
  if (existing) return Promise.resolve(existing);

  const url = scriptUrl || REPLAY_SCRIPT_URL;
  const cached = pending.get(url);
  if (cached) return cached;

  const promise = new Promise<RecordFn>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = url;
    script.async = true;
    if (url === REPLAY_SCRIPT_URL) {
      script.integrity = REPLAY_SCRIPT_INTEGRITY;
      script.crossOrigin = "anonymous";
    }
    script.onload = () => {
      const record = readGlobalRecord();
      if (record) resolve(record);
      else reject(new Error(`Session replay: ${url} did not define rrwebRecord`));
    };
    script.onerror = () =>
      reject(new Error(`Session replay: failed to load ${url}`));
    (document.head || document.documentElement).appendChild(script);
  });
  // A failed load may succeed later (flaky network), so do not cache it.
  promise.catch(() => pending.delete(url));
  pending.set(url, promise);
  return promise;
}
