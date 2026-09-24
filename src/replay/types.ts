/**
 * The subset of rrweb this SDK relies on, duck-typed so that rrweb is never a
 * dependency of the package. `@rrweb/record` (npm) and its UMD build (CDN)
 * both provide a `record` function with this shape.
 */
export interface ReplayEvent {
  type: number;
  data: any;
  timestamp: number;
}

export type ReplayEmit = (event: ReplayEvent, isCheckout?: boolean) => void;

export interface RecordFn {
  (options: Record<string, unknown> & { emit: ReplayEmit }): (() => void) | undefined;
  /** Present on rrweb 2.x. Emits a fresh Meta + FullSnapshot pair. */
  takeFullSnapshot?: (isCheckout?: boolean) => void;
}

/**
 * Session replay configuration. Replay is off unless `replay` is set.
 */
export interface ReplayOptions {
  /**
   * Share of browser tabs to record, from 0 to 1. The decision is made once
   * per replay and kept for its lifetime, so a sampled-out tab stays out
   * across reloads.
   * @default 1
   */
  sampleRate?: number;
  /**
   * rrweb's `record` function. Pass it when you bundle the SDK from npm:
   * `import { record } from "@rrweb/record"`. When absent, the SDK loads the
   * recorder from `scriptUrl`.
   */
  record?: RecordFn;
  /**
   * Where to load the rrweb recorder from when `record` is not passed. The
   * default is a pinned `@rrweb/record` build on jsDelivr, checked with
   * subresource integrity. Set this to serve the file from your own origin
   * (the integrity check is then skipped, since the file is yours).
   */
  scriptUrl?: string;
  /**
   * Mask the value of every input, textarea and select.
   * @default true
   */
  maskAllInputs?: boolean;
  /**
   * CSS selector whose text content is masked, in addition to elements with
   * the `data-formo-mask` attribute.
   */
  maskTextSelector?: string;
  /**
   * CSS selector whose elements are not recorded at all (shown as an empty
   * box), in addition to elements with the `data-formo-block` attribute.
   */
  blockSelector?: string;
}
