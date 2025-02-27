import fetch from "fetch-retry";
import isNetworkError from "is-network-error";
import FingerprintJS from "@fingerprintjs/fingerprintjs";
import { RequestEvent } from "./types";

const sdkFetch = fetch(global.fetch);

const noop = () => {};

type QueueItem = {
  message: RequestEvent;
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

const DEFAULT_FLUSH_INTERVAL = 1_000 * 60; // 1 MINUTE
const MAX_FLUSH_INTERVAL = 1_000 * 300; // 5 MINUTES
const MIN_FLUSH_INTERVAL = 1_000 * 10; // 10 SECONDS

export class FormoAnalyticsEventQueue {
  private writeKey: string;
  private url: string;
  private queue: QueueItem[];
  private timer: null | NodeJS.Timeout;
  private flushAt: number;
  private flushInterval: number;
  private flushed: boolean;
  private maxQueueSize: number; // min 200 bytes, max 500kB
  private errorHandler: any;
  private retryCount: number;
  private pendingFlush: Promise<any> | null;

  constructor(writeKey: string, options: Options) {
    options = options || {};

    this.queue = [];
    this.writeKey = writeKey;
    this.url = options.url;
    this.retryCount = this.getFormattedNumericParams(
      options.retryCount || DEFAULT_RETRY,
      MAX_RETRY,
      MIN_RETRY
    );
    this.flushAt = this.getFormattedNumericParams(
      options.flushAt || DEFAULT_FLUSH_AT,
      MAX_FLUSH_AT,
      MIN_FLUSH_AT
    );
    this.maxQueueSize = this.getFormattedNumericParams(
      options.maxQueueSize || DEFAULT_QUEUE_SIZE,
      MAX_QUEUE_SIZE,
      MIN_QUEUE_SIZE
    );
    this.flushInterval = this.getFormattedNumericParams(
      options.flushInterval || DEFAULT_FLUSH_INTERVAL,
      MAX_FLUSH_INTERVAL,
      MIN_FLUSH_INTERVAL
    );
    this.flushed = true;
    this.errorHandler = options.errorHandler;
    this.pendingFlush = null;
    this.timer = null;

    // flush before page close
    window.addEventListener("beforeunload", async (e) => {
      e.stopImmediatePropagation();
      await this.flush();
    });
  }

  //#region Public functions
  enqueue(message: RequestEvent, callback?: (...args: any) => void) {
    callback = callback || noop;

    // check if the message already exists
    if (this.checkDuplicate(message)) {
      console.warn(
        `Event already enqueued, try again after ${this.millisecondsToSecond(
          this.flushInterval
        )} seconds.`
      );
      return;
    }

    this.queue.push({ message, callback });
    console.log(
      `Event enqueued: ${this.getActionDescriptor(
        message.action,
        message.payload
      )}`
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

    if (this.flushInterval && !this.timer) {
      this.timer = setTimeout(this.flush.bind(this), this.flushInterval);
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
    const data = items.map((item) => item.message);

    const done = (err?: Error) => {
      items.forEach(({ message, callback }) => callback(err, message, data));
      callback(err, data);
    };

    const req = {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${this.writeKey}`,
        "X-Visitor-Id": await this.getVisitorId(),
      },
    };

    return (this.pendingFlush = sdkFetch(`${this.url}`, {
      method: "POST",
      body: JSON.stringify(data),
      retries: this.retryCount,
      retryDelay: (attempt) => Math.pow(2, attempt) * 1_000, // exponential backoff
      retryOn: (_, error) => this.isErrorRetryable(error),
      ...req,
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

  //#endregion

  //#region Utility functions

  private async getVisitorId(): Promise<string> {
    const fp = await FingerprintJS.load();
    const { visitorId } = await fp.get();
    return visitorId;
  }

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

  private millisecondsToSecond(milliseconds: number): number {
    return Math.ceil(milliseconds / 1_000);
  }

  private toDateHourMinute(date: Date) {
    return (
      date.getUTCFullYear() +
      "-" +
      ("0" + (date.getUTCMonth() + 1)).slice(-2) +
      "-" +
      ("0" + date.getUTCDate()).slice(-2) +
      " " +
      ("0" + date.getUTCHours()).slice(-2) +
      ":" +
      ("0" + date.getUTCMinutes()).slice(-2)
    );
  }

  private checkDuplicate(newMessage: RequestEvent) {
    // check if exists a message with identical payload within 1 minute
    const formattedTimestamp = this.toDateHourMinute(
      new Date(newMessage.timestamp)
    );
    const stringifiedMessage = JSON.stringify({
      ...newMessage,
      timestamp: formattedTimestamp,
    });

    return this.queue.some((item) => {
      const { message } = item;
      const formattedItemTimestamp = this.toDateHourMinute(
        new Date(message.timestamp)
      );
      const stringifiedItem = JSON.stringify({
        ...message,
        timestamp: formattedItemTimestamp,
      });

      return stringifiedItem === stringifiedMessage;
    });
  }

  private getActionDescriptor(action: string, payload: any): string {
    return `${action}${payload?.status ? ` ${payload?.status}` : ""}`;
  }

  private getFormattedNumericParams(value: number, max: number, min: number) {
    if (value < min) return min;
    if (value > max) return max;

    return value;
  }
  //#endregion
}
