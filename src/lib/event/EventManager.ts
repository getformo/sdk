import { Address, APIEvent } from "../../types";
import { logger } from "../logger";
import { IEventQueue } from "../queue";
import { IStorageKeyManager } from "../storage";
import { EventFactory } from "./EventFactory";
import { IEventFactory, IEventManager } from "./type";

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
  constructor(eventQueue: IEventQueue, storageKeyManager: IStorageKeyManager) {
    this.eventQueue = eventQueue;
    this.eventFactory = new EventFactory(storageKeyManager);
  }

  /**
   * Consumes a new incoming event
   * @param event Incoming event data
   */
  addEvent(event: APIEvent, address?: Address, userId?: string): void {
    const { callback, ..._event } = event;
    const formoEvent = this.eventFactory.create(_event, address, userId);
    this.eventQueue.enqueue(formoEvent, (err, _, data) => {
      if (err) {
        logger.error("Error sending events:", err);
      } else logger.info(`Events sent successfully: ${data.length} events`);
      callback?.(err, _, data);
    });
  }
}

export { EventManager };
