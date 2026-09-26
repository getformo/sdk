import type { IFormoEvent, IFormoEventProperties } from "../types/events";

/**
 * The subset of rrweb this SDK relies on, duck-typed so that rrweb is never a
 * dependency of the package. `@rrweb/record` provides a `record` function
 * with this shape.
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

/** Where the recorder keeps its per-tab state. The SDK passes sessionStorage. */
export interface ReplayStorage {
  get(key: string): unknown;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export interface ReplayLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/**
 * What the recorder needs from the SDK. Services are injected rather than
 * imported so the CDN replay bundle carries none of the core SDK, and shares
 * its storage, transport and logger instead of running second copies.
 */
export interface ReplayRecorderDeps {
  writeKey: string;
  /** The events endpoint, or the customer's `apiHost` proxy. */
  apiHost: string;
  options: ReplayOptions;
  storage: ReplayStorage;
  generateId: () => string;
  logger: ReplayLogger;
  /** Consent only. Gates every send. */
  canSend: () => boolean;
  /** Consent plus visitor and page exclusions. Gates what is recorded. */
  canRecord: () => boolean;
  /** Identity and context for a chunk, built the way every event is. */
  createEnvelope: (properties: IFormoEventProperties) => Promise<IFormoEvent>;
  /** The SDK's URL redaction, applied to the page URL rrweb records. */
  redactUrl: (href: string) => string;
}

/** The recorder as the SDK core sees it. */
export interface ReplayController {
  /** The id of the replay being recorded, or undefined when not recording. */
  readonly replayId: string | undefined;
  start(): Promise<void>;
  /** With `discard`, buffered events are dropped instead of sent. */
  stop(discard?: boolean): void;
  reset(): void;
}

export type ReplayRecorderFactory = (deps: ReplayRecorderDeps) => ReplayController;

/** What the replay bundle puts on `window.FormoReplay`. */
export interface ReplayBundle {
  createRecorder: ReplayRecorderFactory;
  record: RecordFn;
}

/**
 * Session replay configuration. Replay is off unless `replay` is set.
 *
 * The recorder is not part of the core SDK. With `replay: true` (or an
 * object without `recorder`), the SDK loads its replay bundle from a CDN
 * only when replay starts. npm users can bundle it instead with
 * `replay(...)` from `@formo/analytics/replay`.
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
   * rrweb's `record` function, from `@rrweb/record`. Only read with a
   * bundled recorder; the CDN replay bundle carries its own.
   */
  record?: RecordFn;
  /**
   * The recorder, set by `replay()` from `@formo/analytics/replay`. When
   * absent, the SDK loads the replay bundle from `scriptUrl`.
   */
  recorder?: ReplayRecorderFactory;
  /**
   * Where to load the replay bundle from. The default is this SDK version's
   * `dist/replay.umd.min.js` on jsDelivr, then unpkg, checked with
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
