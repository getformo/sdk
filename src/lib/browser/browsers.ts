// src/lib/browser/browsers.ts
export type BrowserName =
  | "brave"
  | "chrome"
  | "edge"
  | "firefox"
  | "safari"
  | "opera"
  | "unknown";

let inFlight: Promise<BrowserName> | null = null;
let cached: BrowserName | null = null;

function getUA(): string {
  try {
    return typeof globalThis.navigator !== "undefined"
      ? globalThis.navigator.userAgent
      : "";
  } catch {
    return "";
  }
}

async function isBraveHeuristic(): Promise<boolean> {
  const nav: any =
    typeof globalThis.navigator !== "undefined"
      ? (globalThis.navigator as any)
      : undefined;
  if (!nav) return false;

  try {
    if (nav.brave?.isBrave) {
      const ok = await nav.brave.isBrave().catch(() => false);
      if (ok) return true;
    }
  } catch {}

  try {
    const brands: Array<{ brand: string; version: string }> | undefined =
      nav.userAgentData?.brands;
    if (brands?.some((b) => /Brave/i.test(b.brand))) return true;
  } catch {}

  try {
    if (/Brave/i.test(nav.userAgent)) return true;
  } catch {}

  return false;
}

function classifyNonBrave(ua: string): BrowserName {
  if (/Firefox\/\d+/i.test(ua)) return "firefox";
  if (/Edg\/\d+/i.test(ua)) return "edge";
  if (/OPR\/\d+/i.test(ua)) return "opera";
  if (/Safari\/\d+/i.test(ua) && !/Chrome\/\d+/i.test(ua)) return "safari";
  if (/Chrome\/\d+/i.test(ua)) return "chrome";
  return "unknown";
}

export function detectBrowser(): Promise<BrowserName> {
  if (cached) return Promise.resolve(cached);
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const ua = getUA();
    const brave = await isBraveHeuristic().catch(() => false);
    cached = brave ? "brave" : classifyNonBrave(ua);
    return cached;
  })().finally(() => {
    inFlight = null; // subsequent calls hit cache
  });

  return inFlight;
}
