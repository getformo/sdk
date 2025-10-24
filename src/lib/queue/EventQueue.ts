import { isNetworkError } from "../../validators";
import { IFormoEvent, IFormoEventPayload } from "../../types";
import {
  clampNumber,
  getActionDescriptor,
  hash,
  millisecondsToSecond,
  toDateHourMinute,
} from "../../utils";
import { logger } from "../logger";
import { EVENTS_API_REQUEST_HEADER } from "../../constants";
import fetch from "../fetch";
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
  url: string;
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

const DEFAULT_FLUSH_INTERVAL = 1_000 * 30; // 1 MINUTE
const MAX_FLUSH_INTERVAL = 1_000 * 300; // 5 MINUTES
const MIN_FLUSH_INTERVAL = 1_000 * 10; // 10 SECONDS

// Deduplication window: how long to keep event hashes for duplicate detection
// This should be long enough to catch rapid duplicate events across flush cycles
const DEDUPLICATION_WINDOW_MS = 1_000 * 60; // 60 seconds

export class EventQueue implements IEventQueue {
  private writeKey: string;
  private url: string;
  private queue: QueueItem[] = [];
  private timer: null | NodeJS.Timeout;
  private flushAt: number;
  private flushIntervalMs: number;
  private flushed: boolean;
  private maxQueueSize: number; // min 200 bytes, max 500kB
  private errorHandler: any;
  private retryCount: number;
  private pendingFlush: Promise<any> | null;
  private payloadHashes: Map<string, number> = new Map(); // Map hash to timestamp for time-based cleanup

  constructor(writeKey: string, options: Options) {
    options = options || {};

    this.queue = [];
    this.writeKey = writeKey;
    this.url = options.url;
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
  /**
   * Generate a unique message ID for deduplication
   * Uses second-level precision for better granularity while still catching rapid duplicates
   * Returns both the hash and the event's timestamp for consistent time-based deduplication
   */
  private async generateMessageId(event: IFormoEvent): Promise<{ hash: string; timestamp: number }> {
    // Format timestamp to second precision (YYYY-MM-DD HH:mm:ss) for better deduplication
    const date = new Date(event.original_timestamp);
    const eventTimestamp = date.getTime(); // Get timestamp in milliseconds
    
    const formattedTimestamp = 
      date.getUTCFullYear() + "-" +
      ("0" + (date.getUTCMonth() + 1)).slice(-2) + "-" +
      ("0" + date.getUTCDate()).slice(-2) + " " +
      ("0" + date.getUTCHours()).slice(-2) + ":" +
      ("0" + date.getUTCMinutes()).slice(-2) + ":" +
      ("0" + date.getUTCSeconds()).slice(-2);
    
    const eventForHashing = { ...event, original_timestamp: formattedTimestamp };
    const eventString = JSON.stringify(eventForHashing);
    const hashValue = await hash(eventString);
    
    return { hash: hashValue, timestamp: eventTimestamp };
  }

  async enqueue(event: IFormoEvent, callback?: (...args: any) => void) {
    callback = callback || noop;

    const { hash: message_id, timestamp: eventTimestamp } = await this.generateMessageId(event);
    // check if the message already exists within the deduplication window
    // Use the event's timestamp (not Date.now()) for consistent time-based deduplication
    if (await this.isDuplicate(message_id, eventTimestamp)) {
      // Duplicate detected - isDuplicate() already logged a detailed warning
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

    try {
      if (this.pendingFlush) {
        await this.pendingFlush;
      }
    } catch (err) {
      this.pendingFlush = null;
      throw err;
    }

    const items = this.queue.splice(0, this.flushAt);
    
    // Note: We no longer clear payloadHashes on flush to maintain deduplication across flush cycles
    // Old hashes are cleaned up automatically in isDuplicate() based on DEDUPLICATION_WINDOW_MS
    
    // Generate sent_at once for the entire batch
    const sentAt = new Date().toISOString();
    const data: IFormoEventFlushPayload[] = items.map((item) => ({
      ...item.message,
      sent_at: sentAt
    }));

    const done = (err?: Error) => {
      items.forEach(({ message, callback }) => callback(err, message, data));
      callback(err, data);
    };

    return (this.pendingFlush = fetch(`${this.url}`, {
      headers: EVENTS_API_REQUEST_HEADER(this.writeKey),
      method: "POST",
      body: JSON.stringify(data),
      keepalive: true,
      retries: this.retryCount,
      retryDelay: (attempt) => Math.pow(2, attempt) * 1_000, // exponential backoff
      retryOn: (_, error) => this.isErrorRetryable(error),
    })
      .then(() => {
        done();
        return Promise.resolve(data);
      })
      .catch((err) => {
        if (typeof this.errorHandler === "function") {
          done(err);
          return this.errorHandler(err);
        }

        if (err.response) {
          const error = new Error(err.response.statusText);
          done(error);
          throw error;
        }

        done(err);
        throw err;
      }));
  }

  //#region Utility functions
  private isErrorRetryable(error: any) {
    // Retry Network Errors.
    if (isNetworkError(error)) return true;

    // Cannot determine if the request can be retried
    if (!error?.response) return false;

    // Retry Server Errors (5xx).
    if (error?.response?.status >= 500 && error?.response?.status <= 599)
      return true;

    // Retry if rate limited.
    if (error?.response?.status === 429) return true;

    return false;
  }

  /**
   * Check if an event is a duplicate and clean up old hashes
   * Events are considered duplicates if they have the same hash within the deduplication window
   * @param eventId The hash of the event
   * @param eventTimestamp The timestamp from the event's original_timestamp field (NOT current system time)
   */
  private async isDuplicate(eventId: string, eventTimestamp: number): Promise<boolean> {
    // Clean up old hashes that are outside the deduplication window
    // Use eventTimestamp (not Date.now()) to ensure consistency with hash generation
    const hashesToDelete: string[] = [];
    this.payloadHashes.forEach((storedTimestamp, hash) => {
      if (eventTimestamp - storedTimestamp > DEDUPLICATION_WINDOW_MS) {
        hashesToDelete.push(hash);
      }
    });
    hashesToDelete.forEach(hash => this.payloadHashes.delete(hash));
    
    // Check if this event already exists within the deduplication window
    if (this.payloadHashes.has(eventId)) {
      const existingTimestamp = this.payloadHashes.get(eventId)!;
      const timeSinceLastEvent = eventTimestamp - existingTimestamp;
      logger.warn(
        `Duplicate event detected and blocked. Same event was sent ${Math.round(timeSinceLastEvent / 1000)}s ago. ` +
        `Events are deduplicated within a ${DEDUPLICATION_WINDOW_MS / 1000}s window.`
      );
      return true;
    }

    // Store the hash with the event's timestamp (not current system time)
    this.payloadHashes.set(eventId, eventTimestamp);
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
