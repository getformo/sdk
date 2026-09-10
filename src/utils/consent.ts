/**
 * Consent is a page-wide fact per write key, while a queue's clearSeq is per
 * instance. A withdrawal must invalidate work held by every queue for that
 * key, including one already torn down, whose clear() the app can no longer
 * reach.
 *
 * Kept on the page, not in this module: a tag manager can inject the bundle
 * twice, and a withdrawal recorded by one copy has to be visible to the
 * other. Same reasoning as the formofy() registry.
 */
const SLOT = Symbol.for("formo.consent");

const generations = (): Record<string, number> => {
  const w = window as unknown as Record<symbol, Record<string, number> | undefined>;
  return (w[SLOT] = w[SLOT] ?? {});
};

/** How many times consent has been withdrawn for this write key. */
export function consentGeneration(writeKey: string): number {
  if (typeof window === "undefined") return 0;
  return generations()[writeKey] ?? 0;
}

/** Record a withdrawal, so work accepted before it can be recognised. */
export function withdrawConsent(writeKey: string): void {
  if (typeof window === "undefined") return;
  generations()[writeKey] = consentGeneration(writeKey) + 1;
}
