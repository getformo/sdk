import { Address, APIEvent, Options } from "../../types";
import { logger } from "../logger";
import { EventFactory } from "./EventFactory";
import { IEventFactory, IEventManager, IEventQueue } from "./types";
import { isBlockedAddress } from "../../utils/address";

/**
 * Event manager for React Native SDK
 * Generates valid event payloads and queues them for processing
 */
class EventManager implements IEventManager {
  eventQueue: IEventQueue;
  eventFactory: IEventFactory;

  constructor(eventQueue: IEventQueue, options?: Options) {
    this.eventQueue = eventQueue;
    this.eventFactory = new EventFactory(options);
  }

  /**
   * Add event to queue
   */
  async addEvent(
    event: APIEvent,
    address?: Address,
    userId?: string
  ): Promise<void> {
    const { callback, ..._event } = event;
    const formoEvent = await this.eventFactory.create(_event, address, userId);

    // Check if the final event has a blocked address
    if (formoEvent.address && isBlockedAddress(formoEvent.address)) {
      logger.warn(
        `Event blocked: Address ${formoEvent.address} is in the blocked list`
      );
      return;
    }

    this.eventQueue.enqueue(formoEvent, (err, _, data) => {
      if (err) {
        logger.error("Error sending events:", err);
      } else {
        logger.info(`Events sent successfully: ${(data as unknown[])?.length ?? 0} events`);
      }
      callback?.(err, _, data);
    });
  }
}

export { EventManager };
