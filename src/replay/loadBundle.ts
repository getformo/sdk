import { version } from "../version";
import { ReplayBundle } from "./types";

declare global {
  interface Window {
    FormoReplay?: ReplayBundle;
  }
}

/**
 * The sha384 of this version's `dist/replay.umd.min.js`. The token below is
 * replaced in every built file by scripts/replay-integrity.js, after the
 * replay bundle is built and before the package is packed, so the published
 * core and the published replay bundle always agree.
 */
const REPLAY_BUNDLE_INTEGRITY = "__FORMO_REPLAY_BUNDLE_INTEGRITY__";

/**
 * The replay bundle ships inside the npm package, so every CDN that mirrors
 * npm serves the same bytes for this version. jsDelivr first, unpkg if it
 * fails.
 */
export function replayBundleUrls(): string[] {
  const path = `@formo/analytics@${version}/dist/replay.umd.min.js`;
  return [`https://cdn.jsdelivr.net/npm/${path}`, `https://unpkg.com/${path}`];
}

function loadScript(url: string, integrity?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = url;
    script.async = true;
    if (integrity) {
      script.integrity = integrity;
      script.crossOrigin = "anonymous";
    }
    script.onload = () => resolve();
    script.onerror = () => {
      script.remove();
      reject(new Error(`Session replay: failed to load ${url}`));
    };
    (document.head || document.documentElement).appendChild(script);
  });
}

let pending: Promise<ReplayBundle> | undefined;

/**
 * Load the replay bundle once per page. A custom `scriptUrl` is the
 * customer's own file and loads as given; the default CDN files load only
 * with the integrity check, so a compromised CDN cannot run other code on
 * the customer's page.
 */
export function loadReplayBundle(scriptUrl?: string): Promise<ReplayBundle> {
  if (window.FormoReplay) return Promise.resolve(window.FormoReplay);
  if (pending) return pending;

  let urls: string[];
  let integrity: string | undefined;
  if (scriptUrl) {
    urls = [scriptUrl];
  } else if (REPLAY_BUNDLE_INTEGRITY.indexOf("sha384-") === 0) {
    urls = replayBundleUrls();
    integrity = REPLAY_BUNDLE_INTEGRITY;
  } else {
    // Only a build that skipped scripts/replay-integrity.js gets here.
    return Promise.reject(
      new Error("Session replay: this build has no replay bundle integrity; set replay.scriptUrl")
    );
  }

  // Plain promise chain, not async/await: the core targets ES5, where each
  // async function compiles to a state machine, and this code ships to every
  // site whether or not it records.
  const attempt = (i: number): Promise<ReplayBundle> =>
    loadScript(urls[i], integrity).then(
      () => {
        if (window.FormoReplay) return window.FormoReplay;
        throw new Error(`Session replay: ${urls[i]} did not define FormoReplay`);
      },
      (error) => {
        if (i + 1 < urls.length) return attempt(i + 1);
        throw error;
      }
    );
  pending = attempt(0);
  // A failed load may succeed later (flaky network), so do not cache it.
  pending.catch(() => {
    pending = undefined;
  });
  return pending;
}
