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

type QueueItem = {
  message: IFormoEventPayload;
  callback: (...args: any) => any;
};

type IFormoEventFlushPayload = IFormoEventPayload & {
  sent_at: string;
};

type Options = {
  apiHost: string;
  flushAt?: number;
  flushInterval?: number;
  host?: string;
  retryCount?: number;
  errorHandler?: any;
  maxQueueSize?: number;
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

export class EventQueue implements IEventQueue {
  private writeKey: string;
  private apiHost: string;
  private queue: QueueItem[] = [];
  private timer: null | NodeJS.Timeout;
  private flushAt: number;
  private flushIntervalMs: number;
  private flushed: boolean;
  private maxQueueSize: number; // min 200 bytes, max 500kB
  private errorHandler: any;
  private retryCount: number;
  private pendingFlush: Promise<any> | null;
  private payloadHashes: Set<string> = new Set();

  constructor(writeKey: string, options: Options) {
    options = options || {};

    this.queue = [];
    this.writeKey = writeKey;
    this.apiHost = options.apiHost;
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
        await this.flush();
      }
    });
  }

  //#region Public functions
  private async generateMessageId(event: IFormoEvent): Promise<string> {
    const formattedTimestamp = toDateHourMinute(new Date(event.original_timestamp));
    const eventForHashing = { ...event, original_timestamp: formattedTimestamp };
    const eventString = JSON.stringify(eventForHashing);
    return hash(eventString);
  }

  async enqueue(event: IFormoEvent, callback?: (...args: any) => void) {
    callback = callback || noop;

    const message_id = await this.generateMessageId(event);
    // check if the message already exists
    if (await this.isDuplicate(message_id)) {
      logger.warn(
        `Event already enqueued, try again after ${millisecondsToSecond(
          this.flushIntervalMs
        )} seconds.`
      );
      return;
    }

    this.queue.push({
      message: { ...event, message_id },
      callback,
    });

    logger.log(
      `Event enqueued: ${getActionDescriptor(event.type, event.properties)}`
    );

    if (!this.flushed) {
      this.flushed = true;
      this.flush();
      return;
    }

    const hasReachedFlushAt = this.queue.length >= this.flushAt;
    const hasReachedQueueSize =
      this.queue.reduce((acc, item) => acc + JSON.stringify(item).length, 0) >=
      this.maxQueueSize;

    if (hasReachedFlushAt || hasReachedQueueSize) {
      this.flush();
      return;
    }

    if (this.flushIntervalMs && !this.timer) {
      this.timer = setTimeout(this.flush.bind(this), this.flushIntervalMs);
    }
  }

  async flush(callback?: (...args: any) => void) {
    callback = callback || noop;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (!this.queue.length) {
      callback();
      return Promise.resolve();
    }

    if (this.pendingFlush) {
      await this.pendingFlush;
    }

    const items = this.queue.splice(0, this.flushAt);
    this.payloadHashes.clear();

    // Generate sent_at once for the entire batch
    const sentAt = new Date().toISOString();
    const data: IFormoEventFlushPayload[] = items.map((item) => ({
      ...item.message,
      sent_at: sentAt
    }));

    // Split the batch into chunks that fit within the keepalive payload limit.
    // Browsers enforce a cumulative 64KB limit across all in-flight keepalive
    // requests, so batches must be sent sequentially to avoid exceeding it.
    const batches = this.splitIntoBatches(data);

    // Map each batch back to its source items so we can report per-item
    // success/failure. Items and data are in the same order; batches are
    // contiguous slices of data, so we walk items in lockstep.
    type BatchWithItems = { data: IFormoEventFlushPayload[]; keepalive: boolean; items: QueueItem[] };
    let offset = 0;
    const batchesWithItems: BatchWithItems[] = batches.map((batch) => {
      const batchItems = items.slice(offset, offset + batch.data.length);
      offset += batch.data.length;
      return { ...batch, items: batchItems };
    });

    const sendBatches = async () => {
      let firstError: Error | undefined;

      for (const batch of batchesWithItems) {
        try {
          const body = JSON.stringify(batch.data);
          const response = await fetch(`${this.apiHost}`, {
            headers: EVENTS_API_REQUEST_HEADER(this.writeKey),
            method: "POST",
            body,
            keepalive: batch.keepalive,
            retries: this.retryCount,
            retryDelay: (attempt) => Math.pow(2, attempt) * 1_000, // exponential backoff
            retryOn: (_, error, response) => this.isErrorRetryable(error, response),
          });
          if (!response.ok) {
            const error: any = new Error(response.statusText || `HTTP ${response.status}`);
            error.response = response;
            throw error;
          }
          // Notify items in this batch of success
          batch.items.forEach(({ message, callback: cb }) => {
            try { cb(undefined, message, data); } catch { /* swallow */ }
          });
        } catch (err: any) {
          firstError = firstError || err;
          // Notify items in this batch of failure
          batch.items.forEach(({ message, callback: cb }) => {
            try { cb(err, message, data); } catch { /* swallow */ }
          });
        }
      }

      return firstError;
    };

    return (this.pendingFlush = sendBatches()
      .then((firstError) => {
        if (firstError) {
          try { callback(firstError, data); } catch { /* swallow */ }
          if (typeof this.errorHandler === "function") {
            try {
              this.errorHandler(firstError);
            } catch {
              // Swallow errors from user-provided handler to maintain
              // the fire-and-forget contract
            }
          }
        } else {
          try { callback(undefined, data); } catch { /* swallow */ }
        }
        return Promise.resolve(data);
      })
      .catch((err) => {
        // Defensive: should not be reachable since sendBatches catches
        // all errors internally, but guard against unexpected failures.
        try { callback(err, data); } catch { /* swallow */ }
        if (typeof this.errorHandler === "function") {
          try {
            this.errorHandler(err);
          } catch {
            // Swallow
          }
        }
        // Do NOT re-throw — analytics errors should never
        // propagate as unhandled rejections to the host app
      }));
  }

  //#region Utility functions

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
   * Splits a list of events into batches that respect the browser's keepalive
   * payload size limit. Each batch includes a flag indicating whether keepalive
   * is safe to use. If a single event exceeds the limit on its own, it is sent
   * in its own batch with keepalive disabled.
   */
  private splitIntoBatches(data: IFormoEventFlushPayload[]): { data: IFormoEventFlushPayload[]; keepalive: boolean }[] {
    const serialized = JSON.stringify(data);
    if (EventQueue.byteLength(serialized) <= KEEPALIVE_PAYLOAD_LIMIT) {
      return [{ data, keepalive: true }];
    }

    const batches: { data: IFormoEventFlushPayload[]; keepalive: boolean }[] = [];
    let currentBatch: IFormoEventFlushPayload[] = [];
    let currentSize = 2; // account for JSON array brackets "[]"

    for (const event of data) {
      const eventSize = EventQueue.byteLength(JSON.stringify(event));

      // Size with this event added: currentSize + comma (if not first) + eventSize
      const sizeWithEvent = currentSize + (currentBatch.length > 0 ? 1 : 0) + eventSize;

      if (sizeWithEvent > KEEPALIVE_PAYLOAD_LIMIT) {
        // Flush current batch if non-empty
        if (currentBatch.length > 0) {
          batches.push({ data: currentBatch, keepalive: true });
        }

        // If a single event exceeds the limit, send it without keepalive
        if (eventSize + 2 > KEEPALIVE_PAYLOAD_LIMIT) {
          batches.push({ data: [event], keepalive: false });
          currentBatch = [];
          currentSize = 2;
        } else {
          currentBatch = [event];
          currentSize = 2 + eventSize;
        }
      } else {
        currentBatch.push(event);
        currentSize = sizeWithEvent;
      }
    }

    if (currentBatch.length > 0) {
      batches.push({ data: currentBatch, keepalive: true });
    }

    return batches;
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

  private async isDuplicate(eventId: string) {
    // check if exists a message with identical payload within 1 minute
    if (this.payloadHashes.has(eventId)) return true;

    this.payloadHashes.add(eventId);
    return false;
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
      isAccessible = document.visibilityState === "hidden";
      handleOnLeave();
    });

    // Catches visibility changes, such as switching tabs or minimizing the browser.
    document.addEventListener("visibilitychange", () => {
      isAccessible = true;
      if (document.visibilityState === "hidden") {
        handleOnLeave();
      } else {
        pageLeft = false;
      }
    });
  };
}
