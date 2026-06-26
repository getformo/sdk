import {
  Address,
  APIEvent,
  IFormoEventContext,
  IFormoEventProperties,
  Nullable,
  Options,
} from "../types";
import { logger } from "../logger";
import { IEventQueue } from "../queue";
import { EventFactory } from "./EventFactory";
import { IEventFactory, IEventManager } from "./type";
import { isBlockedAddress } from "../utils/address";

/**
 * The set of datasource queues an EventManager writes to. The `events` queue is
 * always present; `profiles`/`labels` are `null` when their ingest host could
 * not be derived from a custom `apiHost` (and no explicit override was given).
 */
export interface DatasourceQueues {
  events: IEventQueue;
  profiles: Nullable<IEventQueue>;
  labels: Nullable<IEventQueue>;
}

/**
 * A service to generate valid event payloads and queue them for processing
 */
class EventManager implements IEventManager {
  eventQueue: IEventQueue;
  profileQueue: Nullable<IEventQueue>;
  labelQueue: Nullable<IEventQueue>;
  eventFactory: IEventFactory;

  /**
   * @param queues Per-datasource queues (events / profiles / labels). All share
   *   the same write key and consent gate; profiles/labels may be null.
   * @param options Optional configuration (referral parsing, etc.)
   */
  constructor(queues: DatasourceQueues, options?: Options) {
    this.eventQueue = queues.events;
    this.profileQueue = queues.profiles;
    this.labelQueue = queues.labels;
    this.eventFactory = new EventFactory(options);
  }

  /**
   * Consumes a new incoming event
   * @param event Incoming event data
   */
  async addEvent(
    event: APIEvent,
    address?: Address,
    userId?: string
  ): Promise<void> {
    const { callback, ..._event } = event;
    const formoEvent = await this.eventFactory.create(_event, address, userId);

    // Check if the final event has a blocked address - don't queue it
    if (formoEvent.address && isBlockedAddress(formoEvent.address)) {
      logger.warn(
        `Event blocked: Address ${formoEvent.address} is in the blocked list and cannot emit events`
      );
      return;
    }

    this.eventQueue.enqueue(formoEvent, (err, _, data) => {
      if (err) {
        logger.error("Error sending events:", err);
      } else logger.info(`Events sent successfully: ${data.length} events`);
      callback?.(err, _, data);
    });
  }

  /**
   * Upsert profile properties to the user_profiles datasource. No-ops when the
   * profiles queue is unavailable (non-derivable custom host).
   */
  async addProfile(
    properties: IFormoEventProperties,
    address?: Nullable<Address>,
    userId?: Nullable<string>,
    context?: IFormoEventContext
  ): Promise<void> {
    if (!this.profileQueue) return;
    const row = await this.eventFactory.createProfile(
      properties,
      address,
      userId,
      context
    );
    if (row.address && isBlockedAddress(row.address)) {
      logger.warn(
        `Profile blocked: Address ${row.address} is in the blocked list and cannot emit profiles`
      );
      return;
    }
    this.profileQueue.enqueue(row, (err, _, data) => {
      if (err) {
        logger.error("Error sending profile:", err);
      } else logger.info(`Profile sent successfully: ${data.length} rows`);
    });
  }

  /**
   * Upsert labels to the user_labels datasource. No-ops when the labels queue is
   * unavailable (non-derivable custom host).
   */
  async addLabels(
    labels: IFormoEventProperties,
    address?: Nullable<Address>,
    userId?: Nullable<string>,
    context?: IFormoEventContext
  ): Promise<void> {
    if (!this.labelQueue) return;
    const row = await this.eventFactory.createLabels(
      labels,
      address,
      userId,
      context
    );
    if (row.address && isBlockedAddress(row.address)) {
      logger.warn(
        `Labels blocked: Address ${row.address} is in the blocked list and cannot emit labels`
      );
      return;
    }
    this.labelQueue.enqueue(row, (err, _, data) => {
      if (err) {
        logger.error("Error sending labels:", err);
      } else logger.info(`Labels sent successfully: ${data.length} rows`);
    });
  }

  /** Drop any buffered events (consent withdrawal / teardown). */
  clear(): void {
    this.eventQueue.clear();
    this.profileQueue?.clear();
    this.labelQueue?.clear();
  }
}

export { EventManager };
