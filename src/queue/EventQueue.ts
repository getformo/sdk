import { isNetworkError } from "../validators";
import { IFormoEvent, IFormoEventPayload } from "../types";
import {
  clampNumber,
  getActionDescriptor,
  hash,
  millisecondsToSecond,
  toDateHourMinute,
} from "../utils";
import { logger } from "../logger";
import { EVENTS_API_REQUEST_HEADER } from "../constants";
import fetch, { FetchRetryError } from "../fetch";
import { IEventQueue } from "./type";
const noop = () => {};
const safeCall = (fn: (...args: any[]) => any, ...args: any[]) => { try { fn(...args); } catch { /* swallow */ } };

type QueueItem = {
  message: IFormoEventPayload;
  callback: (...args: any) => any;
  // Key under which this event is remembered for duplicate suppression, and
  // the acceptance token recorded for it, so a failed send can release
  // exactly its own entry and not a newer one for the same key. See
  // releaseFingerprints.
  dedupKey: string;
  dedupToken: number;
  // Serialized size of this item, computed once at enqueue so the queue
  // byte total can be tracked incrementally (avoids an O(n) re-serialize
  // of the whole queue on every enqueue → O(n^2) overall).
  byteSize: number;
};

type IFormoEventFlushPayload = IFormoEventPayload & {
  sent_at: string;
};

type Batch = {
  data: IFormoEventFlushPayload[];
  items: QueueItem[];
  keepalive: boolean;
};

type Options = {
  apiHost: string;
  flushAt?: number;
  flushInterval?: number;
  host?: string;
  retryCount?: number;
  errorHandler?: any;
  maxQueueSize?: number;
  // Consent predicate, re-checked at enqueue and immediately before any
  // network send. Returning false drops queued data — a timer or
  // pagehide flush scheduled before opt-out must not leak events after.
  canSend?: () => boolean;
};

const DEFAULT_RETRY = 3;
const MAX_RETRY = 5;
const MIN_RETRY = 1;

const DEFAULT_FLUSH_AT = 20;
const MAX_FLUSH_AT = 20;
const MIN_FLUSH_AT = 1;

const DEFAULT_QUEUE_SIZE = 1_024 * 500; // 500kB
const MAX_QUEUE_SIZE = 1_024 * 500; // 500kB
const MIN_QUEUE_SIZE = 200; // 200 bytes

// Browsers enforce a 64KB limit on the total body size of in-flight
// keepalive fetch requests. Payloads exceeding this are silently cancelled,
// producing a TypeError: Failed to fetch that cannot be resolved by retrying.
const KEEPALIVE_PAYLOAD_LIMIT = 64 * 1_024; // 64kB

const DEFAULT_FLUSH_INTERVAL = 1_000 * 30; // 30 SECONDS
const MAX_FLUSH_INTERVAL = 1_000 * 300; // 5 MINUTES
const MIN_FLUSH_INTERVAL = 1_000 * 10; // 10 SECONDS

// How long an accepted event keeps suppressing identical events. A rolling
// window from the moment of acceptance, so a double-fire is caught however
// the wall clock happens to fall (see generateDedupKey).
const DEDUP_WINDOW_MS = 1_000 * 60; // 1 MINUTE

/** Monotonic time where the platform offers one, else undefined. */
const monotonicNow = (): number | undefined =>
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : undefined;

export class EventQueue implements IEventQueue {
  private writeKey: string;
  private apiHost: string;
  private queue: QueueItem[] = [];
  private timer: null | NodeJS.Timeout;
  private flushAt: number;
  private flushIntervalMs: number;
  private flushed: boolean;
  private maxQueueSize: number; // min 200 bytes, max 500kB
  private queueByteSize = 0; // running total of queued items' byteSize
  private errorHandler: any;
  private retryCount: number;
  private pendingFlush: Promise<any> | null;
  // Accepted event fingerprints and when each stops counting as a duplicate.
  //
  // Keyed on time, not on queue membership. Hashes used to be dropped when
  // their event left the queue, which was the same thing while every event
  // waited for the batch timer. Since the first event of a page load is sent
  // the moment it arrives (see enqueue), its hash left with it, and an
  // identical track() a moment later, the double-fire this exists to
  // catch, was accepted (#372).
  //
  // Insertion order is expiry order (each entry expires DEDUP_WINDOW_MS after
  // it was added), which is what lets the prune stop at the first live entry.
  // The token is unique per acceptance; see releaseFingerprints.
  private payloadHashes: Map<string, { expiresAt: number; token: number }> =
    new Map();
  private acceptanceSeq = 0;
  // Origins and high-water mark for elapsedNow().
  private readonly wallStart = Date.now();
  private readonly monotonicStart = monotonicNow();
  private lastElapsed = 0;
  private canSend?: () => boolean;
  // Terminal shutdown flag. Once set, enqueue() and flush() are no-ops for
  // the rest of this instance's life. See close().
  private closed = false;
  // Undoes the page-leave listeners installed in the constructor.
  private disposePageLeave: (() => void) | null = null;

  constructor(writeKey: string, options: Options) {
    options = options || {};

    this.queue = [];
    this.writeKey = writeKey;
    this.apiHost = options.apiHost;
    this.canSend = options.canSend;
    this.retryCount = clampNumber(
      options.retryCount || DEFAULT_RETRY,
      MAX_RETRY,
      MIN_RETRY
    );
    this.flushAt = clampNumber(
      options.flushAt || DEFAULT_FLUSH_AT,
      MAX_FLUSH_AT,
      MIN_FLUSH_AT
    );
    this.maxQueueSize = clampNumber(
      options.maxQueueSize || DEFAULT_QUEUE_SIZE,
      MAX_QUEUE_SIZE,
      MIN_QUEUE_SIZE
    );
    this.flushIntervalMs = clampNumber(
      options.flushInterval || DEFAULT_FLUSH_INTERVAL,
      MAX_FLUSH_INTERVAL,
      MIN_FLUSH_INTERVAL
    );
    // Start un-flushed so the first event of the page load is sent
    // immediately (see enqueue). Short visits — e.g. ad-click landings in
    // mobile in-app browsers — often end with the webview process killed
    // before any pagehide/visibilitychange fires, so an event that waits
    // for the batch timer or a lifecycle flush is lost with the process.
    this.flushed = false;
    this.errorHandler = options.errorHandler;
    this.pendingFlush = null;
    this.timer = null;

    this.disposePageLeave = this.onPageLeave(async (isAccessible: boolean) => {
      if (isAccessible === false) {
        await this.flush(undefined, true);
      }
    });
  }

  private async generateMessageId(event: IFormoEvent): Promise<string> {
    const formattedTimestamp = toDateHourMinute(new Date(event.original_timestamp));
    const eventForHashing = { ...event, original_timestamp: formattedTimestamp };
    const eventString = JSON.stringify(eventForHashing);
    return hash(eventString);
  }

  /**
   * The fingerprint duplicates are judged by: the event without its
   * timestamp.
   *
   * Deliberately NOT the message id. That id folds in the timestamp truncated
   * to the minute, because it is the event's identity on the wire and two
   * events a minute apart must never share one. Judging duplicates by it
   * meant a double-fire straddling a minute boundary (:59.999 and :00.001)
   * got two different ids and both were sent. The window is a rolling one
   * from acceptance, so it needs a key that does not change with the clock.
   */
  private async generateDedupKey(event: IFormoEvent): Promise<string> {
    const { original_timestamp: _ignored, ...rest } = event;
    return hash(JSON.stringify(rest));
  }

  /**
   * Drop all queued data and cancel the flush timer. Called on consent
   * withdrawal / SDK teardown so nothing buffered can be sent later.
   */
  clear(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.queue = [];
    this.queueByteSize = 0;
    this.payloadHashes.clear();
  }

  /**
   * Terminal shutdown. Unlike clear(), which only empties the buffer and can
   * be followed by more events (consent is re-granted, say), close() makes
   * this queue permanently inert: every later enqueue() is a no-op and the
   * page-leave listeners are removed. flush() needs no guard of its own,
   * because a closed queue starts empty and can never be filled again.
   *
   * This is the guarantee a torn-down SDK instance needs. Emission decisions
   * and the emission itself are separated by an await in many call paths
   * (event creation is async), so guarding the *caller* cannot work: the
   * instance may be destroyed while the continuation is in flight. Enforcing
   * it here means no holder of a stale reference can ever send.
   *
   * What close() deliberately does NOT stop is a flush already in flight.
   * Those events were accepted while the instance was alive, so they are
   * real data; abandoning them would turn every unmount into silent loss.
   */
  close(): void {
    this.closed = true;
    this.clear();
    if (this.disposePageLeave) {
      safeCall(this.disposePageLeave);
      this.disposePageLeave = null;
    }
  }

  /** True once close() has run. Exposed for teardown assertions. */
  get isClosed(): boolean {
    return this.closed;
  }

  async enqueue(event: IFormoEvent, callback?: (...args: any) => void) {
    callback = callback || noop;

    // A torn-down instance must never buffer, however late the caller
    // arrives. See close().
    if (this.closed) return;

    // Refuse to buffer anything once consent is withdrawn.
    if (this.canSend && !this.canSend()) {
      this.clear();
      return;
    }

    const message_id = await this.generateMessageId(event);
    const dedupKey = await this.generateDedupKey(event);

    // Re-check after the awaits. A caller that entered before close() is
    // suspended here, and on a queue that has not flushed yet its event
    // would push and flush immediately - the exact shape of the bug close()
    // exists to stop.
    if (this.closed) return;
    // Consent can be withdrawn in the same gap. The flush gate would still
    // stop the send, but the contract of this path is to never buffer after
    // withdrawal, not merely to never send.
    if (this.canSend && !this.canSend()) {
      this.clear();
      return;
    }

    // check if an identical event was accepted within the dedup window
    if (this.isDuplicate(dedupKey)) {
      logger.warn(
        `Duplicate event dropped: an identical event was accepted less than ${millisecondsToSecond(
          DEDUP_WINDOW_MS
        )} seconds ago.`
      );
      return;
    }

    const queueItem: QueueItem = {
      message: { ...event, message_id },
      callback,
      dedupKey,
      dedupToken: this.acceptanceSeq,
      byteSize: 0,
    };
    // Measure once here (message only — JSON.stringify drops the
    // callback function anyway), then track the total incrementally.
    queueItem.byteSize = JSON.stringify({
      message: queueItem.message,
    }).length;
    this.queue.push(queueItem);
    this.queueByteSize += queueItem.byteSize;

    logger.log(
      `Event enqueued: ${getActionDescriptor(event.type, event.properties)}`
    );

    if (!this.flushed) {
      this.flushed = true;
      this.flush();
      return;
    }

    const hasReachedFlushAt = this.queue.length >= this.flushAt;
    const hasReachedQueueSize = this.queueByteSize >= this.maxQueueSize;

    if (hasReachedFlushAt || hasReachedQueueSize) {
      this.flush();
      return;
    }

    if (this.flushIntervalMs && !this.timer) {
      this.timer = setTimeout(this.flush.bind(this), this.flushIntervalMs);
    }
  }

  async flush(callback?: (...args: any) => void, drainAll = false) {
    callback = callback || noop;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    // Final consent gate: a timer/pagehide flush may have been scheduled
    // before opt-out. Drop everything rather than send post-withdrawal.
    if (this.canSend && !this.canSend()) {
      this.clear();
      safeCall(callback);
      return Promise.resolve();
    }

    if (!this.queue.length) {
      safeCall(callback);
      return Promise.resolve();
    }

    if (this.pendingFlush) {
      // During page leave (drainAll), skip awaiting the pending flush.
      // Browser lifecycle events (pagehide/beforeunload) do not wait for
      // async operations — if we yield here the page may be terminated
      // before the keepalive fetch for the remaining items is dispatched.
      if (!drainAll) {
        await this.pendingFlush;
      }
    }

    const items = this.queue.splice(0, drainAll ? this.queue.length : this.flushAt);

    // Decrement the running byte total by exactly what left the queue. The
    // dedup hashes stay: they expire on their own clock, not on flush.
    for (const item of items) {
      this.queueByteSize -= item.byteSize;
    }
    // Re-anchor to the exact invariant when the queue empties, so any
    // accumulated drift can never wedge the size gate.
    if (this.queue.length === 0) this.queueByteSize = 0;

    // Generate sent_at once for the entire batch
    const sentAt = new Date().toISOString();
    const data: IFormoEventFlushPayload[] = items.map((item) => ({
      ...item.message,
      sent_at: sentAt
    }));

    // Split into chunks that fit within the browser's 64KB keepalive limit.
    const batches = this.splitIntoBatches(items, data);

    return (this.pendingFlush = this.sendBatches(batches, data)
      .then((firstError) => {
        if (firstError) {
          safeCall(callback, firstError, data);
          if (typeof this.errorHandler === "function") {
            safeCall(this.errorHandler, firstError);
          }
        } else {
          safeCall(callback, undefined, data);
        }
        return Promise.resolve(data);
      })
      .catch((err) => {
        // Defensive: should not be reachable since sendBatches catches
        // all errors internally, but guard against unexpected failures.
        safeCall(callback, err, data);
        if (typeof this.errorHandler === "function") {
          safeCall(this.errorHandler, err);
        }
        // Do NOT re-throw — analytics errors should never
        // propagate as unhandled rejections to the host app
      }));
  }

  /**
   * Returns the UTF-8 byte length of a string. The browser's keepalive limit
   * is enforced on the wire (UTF-8 bytes), not on JS string length (UTF-16
   * code units). Non-ASCII characters (CJK, emoji) can be 2–4x larger in
   * UTF-8 than their string .length suggests.
   */
  private static byteLength(str: string): number {
    return new TextEncoder().encode(str).byteLength;
  }

  /**
   * Splits events into batches that respect the browser's 64KB keepalive
   * payload size limit. Each batch pairs its serialized data with the
   * original queue items (for per-item callback reporting) and a flag
   * indicating whether keepalive is safe to use.
   */
  private splitIntoBatches(items: QueueItem[], data: IFormoEventFlushPayload[]): Batch[] {
    const serialized = JSON.stringify(data);
    if (EventQueue.byteLength(serialized) <= KEEPALIVE_PAYLOAD_LIMIT) {
      return [{ data, items, keepalive: true }];
    }

    const batches: Batch[] = [];
    let currentData: IFormoEventFlushPayload[] = [];
    let currentItems: QueueItem[] = [];
    let currentSize = 2; // account for JSON array brackets "[]"

    for (let i = 0; i < data.length; i++) {
      const event = data[i];
      const eventSize = EventQueue.byteLength(JSON.stringify(event));
      const sizeWithEvent = currentSize + (currentData.length > 0 ? 1 : 0) + eventSize;

      if (sizeWithEvent > KEEPALIVE_PAYLOAD_LIMIT) {
        if (currentData.length > 0) {
          batches.push({ data: currentData, items: currentItems, keepalive: true });
        }

        // If a single event exceeds the limit, send it without keepalive
        if (eventSize + 2 > KEEPALIVE_PAYLOAD_LIMIT) {
          batches.push({ data: [event], items: [items[i]], keepalive: false });
          currentData = [];
          currentItems = [];
          currentSize = 2;
        } else {
          currentData = [event];
          currentItems = [items[i]];
          currentSize = 2 + eventSize;
        }
      } else {
        currentData.push(event);
        currentItems.push(items[i]);
        currentSize = sizeWithEvent;
      }
    }

    if (currentData.length > 0) {
      batches.push({ data: currentData, items: currentItems, keepalive: true });
    }

    return batches;
  }

  /**
   * Sends batches sequentially, notifying per-item callbacks on success/failure.
   * Returns the first error encountered (if any) so the caller can report it.
   */
  private async sendBatches(batches: Batch[], allData: IFormoEventFlushPayload[]): Promise<Error | undefined> {
    let firstError: Error | undefined;

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      // Consent can be withdrawn while a flush is already in flight:
      // batches were spliced before opt-out, and split batches / retry
      // backoff span seconds. Re-check before every send and abandon
      // the remaining batches if consent was revoked mid-flush. They were
      // never sent, so they must not count as accepted either.
      if (this.canSend && !this.canSend()) {
        for (let j = i; j < batches.length; j++) {
          this.releaseFingerprints(batches[j].items);
        }
        break;
      }
      try {
        const body = JSON.stringify(batch.data);
        const response = await fetch(`${this.apiHost}`, {
          headers: EVENTS_API_REQUEST_HEADER(this.writeKey),
          method: "POST",
          body,
          keepalive: batch.keepalive,
          retries: this.retryCount,
          retryDelay: (attempt) => Math.pow(2, attempt) * 1_000,
          retryOn: (_, error, response) => this.isErrorRetryable(error, response),
        });
        if (!response.ok) {
          const error: any = new Error(response.statusText || `HTTP ${response.status}`);
          error.response = response;
          throw error;
        }
        batch.items.forEach(({ message, callback: cb }) => safeCall(cb, undefined, message, allData));
      } catch (err: any) {
        firstError = firstError || err;
        // The batch is lost: retries are exhausted or the response was not
        // retryable. Release its fingerprints so the app can send the same
        // event again after the error callback, instead of having that
        // retry classified as a double-fire and dropped for a minute.
        this.releaseFingerprints(batch.items);
        batch.items.forEach(({ message, callback: cb }) => safeCall(cb, err, message, allData));
      }
    }

    return firstError;
  }

  private isErrorRetryable(error: FetchRetryError | null, response: Response | null) {
    // Retry Network Errors.
    if (error && isNetworkError(error)) return true;

    // Check response status if available
    const status = response?.status ?? error?.response?.status;
    if (!status) return false;

    // Retry Server Errors (5xx).
    if (status >= 500 && status <= 599) return true;

    // Retry if rate limited.
    if (status === 429) return true;

    return false;
  }

  /**
   * Whether an identical event was accepted within the dedup window. Records
   * the key when it was not. Expired keys are pruned here, on the enqueue
   * path, so the map is bounded by one minute of accepted events and needs
   * no timer of its own.
   */
  private isDuplicate(dedupKey: string): boolean {
    const now = this.elapsedNow();
    this.pruneExpired(now);
    if (this.payloadHashes.has(dedupKey)) return true;

    this.payloadHashes.set(dedupKey, {
      expiresAt: now + DEDUP_WINDOW_MS,
      token: ++this.acceptanceSeq,
    });
    return false;
  }

  /**
   * Forget that these events were accepted, so identical ones are taken
   * again. For items that were never delivered.
   *
   * Only an item's OWN entry is released. A send can outlive the window
   * through retry backoff, or be cut short by clear(); by the time it
   * fails, the same event may have been accepted again and be in flight
   * under the same key. The acceptance token tells the two apart. (An
   * expiry would not: clear() and a re-accept can land in the same
   * millisecond as the original.)
   */
  private releaseFingerprints(items: QueueItem[]): void {
    for (const item of items) {
      const entry = this.payloadHashes.get(item.dedupKey);
      if (entry && entry.token === item.dedupToken) {
        this.payloadHashes.delete(item.dedupKey);
      }
    }
  }

  /**
   * Elapsed time since this queue was created, for the dedup window. Never
   * decreases, and errs toward running fast.
   *
   * Two sources, the larger wins. The monotonic clock (performance.now) is
   * immune to wall-clock steps but on some platforms stops while the OS is
   * suspended, so a device that sleeps mid-window would wake still inside
   * it. The wall clock counts suspension but can step: forward steps only
   * expire entries early, which is the safe direction for a duplicate guard;
   * backward steps are absorbed by the other source and by the clamp.
   *
   * The clamp is what lets pruneExpired assume insertion order is expiry
   * order. Per instance, so test clocks that start from zero are not pinned
   * by a previous instance's high-water mark.
   */
  private elapsedNow(): number {
    const wall = Date.now() - this.wallStart;
    const mono = monotonicNow();
    const monotonic =
      mono !== undefined && this.monotonicStart !== undefined
        ? mono - this.monotonicStart
        : 0;
    const raw = Math.max(wall, monotonic);
    if (raw > this.lastElapsed) this.lastElapsed = raw;
    return this.lastElapsed;
  }

  /**
   * Drop expired fingerprints from the front of the map.
   *
   * Entries are in insertion order and every one expires a fixed interval
   * after insertion, so the first live entry ends the scan: each expired
   * entry is visited once in its life, not once per enqueue. The clock never
   * decreases (see elapsedNow), which is what makes insertion order expiry
   * order.
   *
   * Manual iteration: for..of over a Map does not compile under the ES5
   * build target, and Map.forEach cannot stop early. Deleting the current
   * entry mid-iteration is spec-safe.
   */
  private pruneExpired(now: number): void {
    const entries = this.payloadHashes.entries();
    for (let step = entries.next(); !step.done; step = entries.next()) {
      const key = step.value[0];
      if (step.value[1].expiresAt > now) break;
      this.payloadHashes.delete(key);
    }
  }

  /**
   * Installs the page-leave listeners and returns a disposer that removes
   * every one of them. Without the disposer each SDK instance leaked five
   * listeners (three on the global, two on the document) that kept the
   * instance and its queue alive for the life of the page.
   */
  private onPageLeave = (
    callback: (isAccessible: boolean) => void
  ): (() => void) => {
    // To ensure the callback is only called once even if more than one events
    // are fired at once.
    let pageLeft = false;
    let isAccessible = false;
    let resetTimer: null | NodeJS.Timeout = null;

    function handleOnLeave() {
      if (pageLeft) {
        return;
      }

      pageLeft = true;

      callback(isAccessible);

      // Reset pageLeft on the next tick
      // to ensure callback executes for other listeners
      // when closing an inactive browser tab.
      resetTimer = setTimeout(() => {
        resetTimer = null;
        pageLeft = false;
      }, 0);
    }

    const onBeforeUnload = () => {
      isAccessible = false;
      handleOnLeave();
    };
    const onBlur = () => {
      isAccessible = true;
      handleOnLeave();
    };
    const onFocus = () => {
      pageLeft = false;
    };
    const onPageHide = () => {
      isAccessible = document.visibilityState !== "hidden";
      handleOnLeave();
    };
    const onVisibilityChange = () => {
      isAccessible = document.visibilityState !== "hidden";
      if (document.visibilityState === "hidden") {
        handleOnLeave();
      } else {
        pageLeft = false;
      }
    };

    // Captured at install time, not read again at removal time. Teardown can
    // run after the host has swapped or removed these globals (a test harness
    // replacing jsdom between specs, for one), and removing a listener from a
    // different object than it was added to silently leaves it attached.
    const globalTarget = globalThis as unknown as typeof window;
    const documentTarget = document;

    // Catches the unloading of the page (e.g., closing the tab or navigating away).
    // Includes user actions like clicking a link, entering a new URL,
    // refreshing the page, or closing the browser tab
    // Note that 'pagehide' is not supported in IE.
    // So, this is a fallback.
    globalTarget.addEventListener("beforeunload", onBeforeUnload);
    globalTarget.addEventListener("blur", onBlur);
    globalTarget.addEventListener("focus", onFocus);

    // Catches the page being hidden, including scenarios like closing the tab.
    documentTarget.addEventListener("pagehide", onPageHide);

    // Catches visibility changes, such as switching tabs or minimizing the browser.
    documentTarget.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      if (resetTimer) {
        clearTimeout(resetTimer);
        resetTimer = null;
      }
      globalTarget.removeEventListener("beforeunload", onBeforeUnload);
      globalTarget.removeEventListener("blur", onBlur);
      globalTarget.removeEventListener("focus", onFocus);
      documentTarget.removeEventListener("pagehide", onPageHide);
      documentTarget.removeEventListener("visibilitychange", onVisibilityChange);
    };
  };
}
