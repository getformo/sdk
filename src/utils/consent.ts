/**
 * Consent is a page-wide fact per write key, while a queue's clearSeq is per
 * instance. A withdrawal must invalidate work held by every queue for that
 * key, including one already torn down, whose clear() the app can no longer
 * reach.
 */
const generations: Record<string, number> = {};

/** How many times consent has been withdrawn for this write key. */
export function consentGeneration(writeKey: string): number {
  return generations[writeKey] ?? 0;
}

/** Record a withdrawal, so work accepted before it can be recognised. */
export function withdrawConsent(writeKey: string): void {
  generations[writeKey] = consentGeneration(writeKey) + 1;
}
