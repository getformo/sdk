import { AppState, AppStateStatus } from "react-native";
import { IFormoEvent, IFormoEventPayload } from "../../types";
import { EVENTS_API_REQUEST_HEADER } from "../../constants";
import {
  clampNumber,
  getActionDescriptor,
  millisecondsToSecond,
  isNetworkError,
} from "../../utils";
import { hash } from "../../utils/hash";
import { toDateHourMinute } from "../../utils/timestamp";
import { logger } from "../logger";
import { IEventQueue } from "./types";

type QueueItem = {
  message: IFormoEventPayload;
  callback: (...args: unknown[]) => void;
};

type IFormoEventFlushPayload = IFormoEventPayload & {
  sent_at: string;
};

interface Options {
  apiHost: string;
  flushAt?: number;
  flushInterval?: number;
  retryCount?: number;
  maxQueueSize?: number;
}

const DEFAULT_RETRY = 3;
const MAX_RETRY = 5;
const MIN_RETRY = 1;

const DEFAULT_FLUSH_AT = 20;
const MAX_FLUSH_AT = 20;
const MIN_FLUSH_AT = 1;

const DEFAULT_QUEUE_SIZE = 1_024 * 500; // 500kB
const MAX_QUEUE_SIZE = 1_024 * 500; // 500kB
const MIN_QUEUE_SIZE = 200; // 200 bytes

const DEFAULT_FLUSH_INTERVAL = 1_000 * 30; // 30 seconds
const MAX_FLUSH_INTERVAL = 1_000 * 300; // 5 minutes
const MIN_FLUSH_INTERVAL = 1_000 * 10; // 10 seconds

const noop = () => {};

/**
 * Event queue for React Native
 * Handles batching, flushing, and retries with app lifecycle awareness
 */
export class EventQueue implements IEventQueue {
  private writeKey: string;
  private apiHost: string;
  private queue: QueueItem[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushAt: number;
  private flushIntervalMs: number;
  private maxQueueSize: number;
  private retryCount: number;
  private pendingFlush: Promise<unknown> | null = null;
  private payloadHashes: Set<string> = new Set();
  private appStateSubscription: { remove: () => void } | null = null;

  constructor(writeKey: string, options: Options) {
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
    // Set up app state listener for React Native
    this.setupAppStateListener();
  }

  /**
   * Set up listener for app state changes
   * Flush events when app goes to background
   */
  private setupAppStateListener(): void {
    this.appStateSubscription = AppState.addEventListener(
      "change",
      this.handleAppStateChange.bind(this)
    );
  }

  /**
   * Handle app state changes
   */
  private handleAppStateChange(nextAppState: AppStateStatus): void {
    // Flush when app goes to background or becomes inactive
    if (nextAppState === "background" || nextAppState === "inactive") {
      logger.debug("EventQueue: App going to background, flushing events");
      this.flush().catch((error) => {
        logger.error("EventQueue: Failed to flush on background", error);
      });
    }
  }

  /**
   * Generate message ID for deduplication
   */
  private async generateMessageId(event: IFormoEvent): Promise<string> {
    const formattedTimestamp = toDateHourMinute(
      new Date(event.original_timestamp)
    );
    const eventForHashing = { ...event, original_timestamp: formattedTimestamp };
    const eventString = JSON.stringify(eventForHashing);
    return hash(eventString);
  }

  /**
   * Check if event is a duplicate
   */
  private isDuplicate(eventId: string): boolean {
    if (this.payloadHashes.has(eventId)) return true;
    this.payloadHashes.add(eventId);
    return false;
  }

  /**
   * Add event to queue
   */
  async enqueue(
    event: IFormoEvent,
    callback?: (...args: unknown[]) => void
  ): Promise<void> {
    callback = callback || noop;

    const message_id = await this.generateMessageId(event);

    // Check for duplicate
    if (this.isDuplicate(message_id)) {
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

    const hasReachedFlushAt = this.queue.length >= this.flushAt;
    const hasReachedQueueSize =
      this.queue.reduce(
        (acc, item) => acc + JSON.stringify(item).length,
        0
      ) >= this.maxQueueSize;

    if (hasReachedFlushAt || hasReachedQueueSize) {
      this.flush();
      return;
    }

    if (this.flushIntervalMs && !this.timer) {
      this.timer = setTimeout(this.flush.bind(this), this.flushIntervalMs);
    }
  }

  /**
   * Flush events to API
   */
  async flush(callback?: (...args: unknown[]) => void): Promise<void> {
    callback = callback || noop;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (!this.queue.length) {
      callback();
      return;
    }

    // Wait for pending flush
    if (this.pendingFlush) {
      try {
        await this.pendingFlush;
      } catch {
        this.pendingFlush = null;
      }
    }

    const items = this.queue.splice(0, this.flushAt);
    this.payloadHashes.clear();

    const sentAt = new Date().toISOString();
    const data: IFormoEventFlushPayload[] = items.map((item) => ({
      ...item.message,
      sent_at: sentAt,
    }));

    const done = (err?: Error) => {
      items.forEach(({ message, callback: itemCallback }) =>
        itemCallback(err, message, data)
      );
      callback!(err, data);
    };

    this.pendingFlush = this.sendWithRetry(data)
      .then(() => {
        done();
        logger.info(`Events sent successfully: ${data.length} events`);
      })
      .catch((err) => {
        done(err);
        logger.error("Error sending events:", err);
      })
      .finally(() => {
        this.pendingFlush = null;
      });

    return this.pendingFlush as Promise<void>;
  }

  /**
   * Send events with retry logic
   */
  private async sendWithRetry(
    data: IFormoEventFlushPayload[],
    attempt = 0
  ): Promise<void> {
    try {
      const response = await fetch(this.apiHost, {
        method: "POST",
        headers: EVENTS_API_REQUEST_HEADER(this.writeKey),
        body: JSON.stringify(data),
      });

      if (!response.ok) {
        const shouldRetry = this.shouldRetry(response.status);
        if (shouldRetry && attempt < this.retryCount) {
          const delay = Math.pow(2, attempt) * 1000;
          await new Promise((resolve) => setTimeout(resolve, delay));
          return this.sendWithRetry(data, attempt + 1);
        }
        throw new Error(`HTTP error! status: ${response.status}`);
      }
    } catch (error) {
      if (isNetworkError(error) && attempt < this.retryCount) {
        const delay = Math.pow(2, attempt) * 1000;
        logger.warn(`Network error, retrying in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.sendWithRetry(data, attempt + 1);
      }
      throw error;
    }
  }

  /**
   * Check if error should be retried
   */
  private shouldRetry(status: number): boolean {
    // Retry on server errors (5xx) and rate limiting (429)
    return (status >= 500 && status <= 599) || status === 429;
  }

  /**
   * Clean up resources
   */
  public cleanup(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.appStateSubscription) {
      this.appStateSubscription.remove();
      this.appStateSubscription = null;
    }
  }
}
