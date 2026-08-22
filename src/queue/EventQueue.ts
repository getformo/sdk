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
  private payloadHashes: Set<string> = new Set();
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
    // check if the message already exists
    if (this.isDuplicate(message_id)) {
      logger.warn(
        `Event already enqueued, try again after ${millisecondsToSecond(
          this.flushIntervalMs
        )} seconds.`
      );
      return;
    }

    const queueItem: QueueItem = {
      message: { ...event, message_id },
      callback,
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
      // A batching timer must never be the reason a process stays alive.
      // Browsers return a number here and have no unref, so this is a
      // no-op there; under Node (SSR, scripts, this repo's own test run) it
      // stops a pending batch from holding the event loop open for the full
      // flush interval. Anything buffered is still sent by the next
      // enqueue, an explicit flush(), or the page-leave handler.
      if (typeof this.timer?.unref === "function") this.timer.unref();
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

    // Only remove hashes for flushed items so duplicate detection remains
    // active for events still in the queue. Also decrement the running
    // byte total by exactly what left the queue.
    for (const item of items) {
      this.payloadHashes.delete(item.message.message_id);
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

    for (const batch of batches) {
      // Consent can be withdrawn while a flush is already in flight:
      // batches were spliced before opt-out, and split batches / retry
      // backoff span seconds. Re-check before every send and abandon
      // the remaining batches if consent was revoked mid-flush.
      if (this.canSend && !this.canSend()) break;
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

  private isDuplicate(eventId: string) {
    // check if exists a message with identical payload within 1 minute
    if (this.payloadHashes.has(eventId)) return true;

    this.payloadHashes.add(eventId);
    return false;
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

    const globalTarget = globalThis as unknown as typeof window;

    // Catches the unloading of the page (e.g., closing the tab or navigating away).
    // Includes user actions like clicking a link, entering a new URL,
    // refreshing the page, or closing the browser tab
    // Note that 'pagehide' is not supported in IE.
    // So, this is a fallback.
    globalTarget.addEventListener("beforeunload", onBeforeUnload);
    globalTarget.addEventListener("blur", onBlur);
    globalTarget.addEventListener("focus", onFocus);

    // Catches the page being hidden, including scenarios like closing the tab.
    document.addEventListener("pagehide", onPageHide);

    // Catches visibility changes, such as switching tabs or minimizing the browser.
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      if (resetTimer) {
        clearTimeout(resetTimer);
        resetTimer = null;
      }
      globalTarget.removeEventListener("beforeunload", onBeforeUnload);
      globalTarget.removeEventListener("blur", onBlur);
      globalTarget.removeEventListener("focus", onFocus);
      document.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  };
}
