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

const DEFAULT_FLUSH_INTERVAL = 1_000 * 30; // 1 MINUTE
const MAX_FLUSH_INTERVAL = 1_000 * 300; // 5 MINUTES
const MIN_FLUSH_INTERVAL = 1_000 * 10; // 10 SECONDS

// message_id is computed from the event payload + original_timestamp rounded
// to the minute (toDateHourMinute), so two identical events emitted within
// the same UTC minute hash to the same id. Within this window a re-enqueue
// of the same event must be rejected even if the previous one was already
// flushed — otherwise the server sees the same message_id with a fresh
// sent_at on every subsequent flush. The TTL is wider than the rounding
// granularity plus reasonable clock slop so the rejection is reliable, and
// the entry count is capped to keep memory bounded if a misbehaving caller
// floods unique ids.
const DEDUP_TTL_MS = 5 * 60 * 1_000; // 5 minutes
const MAX_DEDUP_ENTRIES = 1_000;

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
  // Insertion-ordered id → first-seen timestamp. Survives across flushes so
  // a re-enqueue of the same event within DEDUP_TTL_MS is rejected even
  // after the previous instance was already sent. Pruned lazily on enqueue.
  private seenMessageIds: Map<string, number> = new Map();
  // Ids of events whose ack hasn't returned — either still buffered in
  // this.queue or in flight via sendBatches. These must be protected from
  // TTL/cap eviction in seenMessageIds; otherwise a duplicate enqueue that
  // slips past dedup while the original is still in transit can cause both
  // copies to reach the server. Removed on send success; on send failure,
  // the seenMessageIds entry is removed too so the caller can retry.
  private unackedIds: Set<string> = new Set();
  private canSend?: () => boolean;

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
    this.flushed = true;
    this.errorHandler = options.errorHandler;
    this.pendingFlush = null;
    this.timer = null;

    this.onPageLeave(async (isAccessible: boolean) => {
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
   *
   * Dedup state is NOT wiped wholesale. We forget only ids that never left
   * the queue (still buffered, never sent) so genuinely un-sent events can be
   * re-emitted after a re-opt-in. Ids that are already in flight — spliced
   * into a request that may yet succeed — are left FULLY intact: both their
   * seenMessageIds entry and their unackedIds protection.
   *
   * Leaving the in-flight ids untouched makes the outstanding sendBatches
   * handlers the sole owner of that state, which is what keeps clear() race-
   * free:
   *   - The seenMessageIds entry preserves cross-flush dedup if the request
   *     lands (re-send of the same message_id with a fresh sent_at is the
   *     regression this map guards against).
   *   - Because the id stays in seenMessageIds, a competing re-enqueue of the
   *     same message_id is still rejected, so no second "generation" of the
   *     id can form for a stale success/failure handler to later clobber.
   *   - Because unackedIds still shields it from TTL/cap eviction, the entry
   *     survives until the request settles, so a slow delivery can still be
   *     anchored to ack time on success.
   * The handlers drop unackedIds on settle (success and failure both), so the
   * protection is released as soon as the request resolves — an id is only
   * "pinned" for as long as its request is genuinely outstanding.
   */
  clear(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Queued ids are never simultaneously in flight (dedup rejects a
    // re-enqueue while the original id is still tracked), so this forgets
    // exactly the never-sent set and leaves in-flight ids alone.
    for (const item of this.queue) {
      this.seenMessageIds.delete(item.message.message_id);
      this.unackedIds.delete(item.message.message_id);
    }
    this.queue = [];
    this.queueByteSize = 0;
  }

  async enqueue(event: IFormoEvent, callback?: (...args: any) => void) {
    callback = callback || noop;

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
    this.unackedIds.add(message_id);

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
      callback();
      return Promise.resolve();
    }

    if (!this.queue.length) {
      callback();
      return Promise.resolve();
    }

    if (this.pendingFlush) {
      // During page leave (drainAll), skip awaiting the pending flush.
      // Browser lifecycle events (pagehide/beforeunload) do not wait for
      // async operations — if we yield here the page may be terminated
      // before the keepalive fetch for the remaining items is dispatched.
      if (!drainAll) {
        await this.pendingFlush;
        // Consent can be withdrawn while we were awaiting the in-flight
        // flush (split batches / retry backoff span seconds). Re-gate
        // before draining: sendBatches would drop these as skipped anyway,
        // but re-checking here avoids the wasted splice and keeps the
        // post-withdrawal "send nothing" semantics explicit.
        if (this.canSend && !this.canSend()) {
          this.clear();
          callback();
          return Promise.resolve();
        }
      }
    }

    const items = this.queue.splice(0, drainAll ? this.queue.length : this.flushAt);

    // A concurrent flush awaiting pendingFlush may resume here after the
    // earlier flush already drained the queue, leaving us with nothing to
    // send. Bail out instead of POSTing an empty array.
    if (items.length === 0) {
      callback();
      return Promise.resolve();
    }

    // Decrement the running byte total by exactly what left the queue.
    // Keep entries in seenMessageIds so a re-enqueue of the same event
    // within the dedup TTL is still rejected after the flush — that's the
    // re-send vector the symptom (same message_id, varying sent_at) maps to.
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
      // the remaining batches if consent was revoked mid-flush. Clear
      // the dedup state for all skipped items — otherwise the unacked
      // markers leak forever (pruneSeenMessageIds protects unacked
      // entries) and a re-opt-in would silently dedup-drop the same
      // events. Items that were never sent are not "delivered duplicates."
      if (this.canSend && !this.canSend()) {
        for (let j = i; j < batches.length; j++) {
          batches[j].items.forEach((item) => {
            this.unackedIds.delete(item.message.message_id);
            this.seenMessageIds.delete(item.message.message_id);
          });
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
        // Delivered. Drop the unacked marker and refresh the dedup entry's
        // timestamp to ack time. While queued/in-flight the entry is kept
        // alive by unackedIds, but it still carries the original enqueue
        // time; if delivery was delayed past DEDUP_TTL_MS (long
        // flushInterval, throttled background-tab timers, slow flush), the
        // next enqueue of the same id would prune it as expired and re-send
        // a duplicate. Anchoring the TTL to delivery time preserves the
        // cross-flush dedup guarantee. delete+set re-inserts at the tail so
        // seenMessageIds stays ordered by timestamp for the early-break
        // prune; the delete() return guards against a concurrent clear().
        const ackTime = Date.now();
        batch.items.forEach((item) => {
          const id = item.message.message_id;
          this.unackedIds.delete(id);
          if (this.seenMessageIds.delete(id)) {
            this.seenMessageIds.set(id, ackTime);
          }
          safeCall(item.callback, undefined, item.message, allData);
        });
      } catch (err: any) {
        firstError = firstError || err;
        // Delivery failed (retries exhausted). Drop both the unacked
        // marker and the seenMessageIds entry so the per-item error
        // callback can re-enqueue without being silently dedup'd —
        // otherwise a transient network blip becomes guaranteed loss.
        batch.items.forEach((item) => {
          this.unackedIds.delete(item.message.message_id);
          this.seenMessageIds.delete(item.message.message_id);
          safeCall(item.callback, err, item.message, allData);
        });
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
    this.pruneSeenMessageIds();
    if (this.seenMessageIds.has(eventId)) return true;
    this.seenMessageIds.set(eventId, Date.now());
    return false;
  }

  /**
   * Drop expired ids and cap the map size. Map iteration is insertion-order,
   * so once we hit a non-expired entry every later entry is also fresher —
   * stop scanning then. Uses Map.prototype.entries/keys directly with
   * .next() so this compiles cleanly under target es5 without needing
   * downlevelIteration. Bounded by MAX_DEDUP_ENTRIES as a safety net.
   *
   * Ids in unackedIds (still queued or in flight) are skipped by both the
   * TTL pass and the cap pass — evicting them would re-open the dedup
   * window against a duplicate enqueue while the original is still in
   * transit, which is exactly the regression we're guarding against.
   */
  private pruneSeenMessageIds(): void {
    const now = Date.now();
    const iter = this.seenMessageIds.entries();
    let next = iter.next();
    while (!next.done) {
      const id = next.value[0];
      const ts = next.value[1];
      if (now - ts > DEDUP_TTL_MS) {
        if (!this.unackedIds.has(id)) {
          this.seenMessageIds.delete(id);
        }
        next = iter.next();
      } else {
        break;
      }
    }

    if (this.seenMessageIds.size > MAX_DEDUP_ENTRIES) {
      const dropCount = this.seenMessageIds.size - MAX_DEDUP_ENTRIES;
      const keyIter = this.seenMessageIds.keys();
      let dropped = 0;
      while (dropped < dropCount) {
        const k = keyIter.next();
        if (k.done) break;
        if (this.unackedIds.has(k.value)) continue;
        this.seenMessageIds.delete(k.value);
        dropped++;
      }
    }
  }

  private onPageLeave = (callback: (isAccessible: boolean) => void) => {
    // To ensure the callback is only called once even if more than one events
    // are fired at once.
    let pageLeft = false;
    let isAccessible = false;

    function handleOnLeave() {
      if (pageLeft) {
        return;
      }

      pageLeft = true;

      callback(isAccessible);

      // Reset pageLeft on the next tick
      // to ensure callback executes for other listeners
      // when closing an inactive browser tab.
      setTimeout(() => {
        pageLeft = false;
      }, 0);
    }

    // Catches the unloading of the page (e.g., closing the tab or navigating away).
    // Includes user actions like clicking a link, entering a new URL,
    // refreshing the page, or closing the browser tab
    // Note that 'pagehide' is not supported in IE.
    // So, this is a fallback.
    (globalThis as typeof window).addEventListener("beforeunload", () => {
      isAccessible = false;
      handleOnLeave();
    });

    (globalThis as typeof window).addEventListener("blur", () => {
      isAccessible = true;
      handleOnLeave();
    });

    (globalThis as typeof window).addEventListener("focus", () => {
      pageLeft = false;
    });

    // Catches the page being hidden, including scenarios like closing the tab.
    document.addEventListener("pagehide", () => {
      isAccessible = document.visibilityState !== "hidden";
      handleOnLeave();
    });

    // Catches visibility changes, such as switching tabs or minimizing the browser.
    document.addEventListener("visibilitychange", () => {
      isAccessible = document.visibilityState !== "hidden";
      if (document.visibilityState === "hidden") {
        handleOnLeave();
      } else {
        pageLeft = false;
      }
    });
  };
}
