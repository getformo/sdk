import isNetworkError from "is-network-error";
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
  private payloadHashes: Set<string> = new Set();

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
  async enqueue(event: IFormoEvent, callback?: (...args: any) => void) {
    callback = callback || noop;

    const formattedTimestamp = toDateHourMinute(new Date(event.timestamp));
    const originTimestamp = event.timestamp;
    event.timestamp = formattedTimestamp;

    const eventString = JSON.stringify(event);
    const eventId = await hash(eventString);
    // check if the message already exists
    if (await this.isDuplicate(eventId)) {
      logger.warn(
        `Event already enqueued, try again after ${millisecondsToSecond(
          this.flushIntervalMs
        )} seconds.`
      );
      return;
    }

    this.queue.push({
      message: { ...event, timestamp: originTimestamp, id: eventId },
      callback,
    });

    logger.log(
      `Event enqueued: ${getActionDescriptor(event.action, event.payload)}`
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
    this.payloadHashes.clear();
    const data = items.map((item) => item.message);

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
