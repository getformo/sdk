import { Address, APIEvent } from "../../types";
import { logger } from "../logger";
import { IEventQueue } from "../queue";
import { EventFactory } from "./EventFactory";
import { IEventFactory, IEventManager } from "./type";
import { isBlockedAddress } from "../../utils/address";

/**
 * A service to generate valid event payloads and queue them for processing
 */
class EventManager implements IEventManager {
  eventQueue: IEventQueue;
  eventFactory: IEventFactory;

  /**
   *
   * @param eventQueue Event queue instance
   */
  constructor(eventQueue: IEventQueue) {
    this.eventQueue = eventQueue;
    this.eventFactory = new EventFactory();
  }

  /**
   * Consumes a new incoming event
   * @param event Incoming event data
   */
  addEvent(event: APIEvent, address?: Address, userId?: string): void {
    const { callback, ..._event } = event;
    const formoEvent = this.eventFactory.create(_event, address, userId);
    
    // Check if the final event has a blocked address - don't queue it
    if (formoEvent.address && isBlockedAddress(formoEvent.address)) {
      logger.warn(`Event blocked: Address ${formoEvent.address} is in the blocked list and cannot emit events`);
      return;
    }

    this.eventQueue.enqueue(formoEvent, (err, _, data) => {
      if (err) {
        logger.error("Error sending events:", err);
      } else logger.info(`Events sent successfully: ${data.length} events`);
      callback?.(err, _, data);
    });
  }
}

export { EventManager };
