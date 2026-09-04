import { Address, APIEvent, Options } from "../types";
import { logger } from "../logger";
import { IEventQueue } from "../queue";
import { EventFactory } from "./EventFactory";
import { EVENT_CREATION_CANCELLED } from "./cancellation";
import { IEventFactory, IEventManager } from "./type";
import { isBlockedAddress } from "../utils/address";

/**
 * A service to generate valid event payloads and queue them for processing
 */
class EventManager implements IEventManager {
  eventQueue: IEventQueue;
  eventFactory: IEventFactory;
  private generation = 0;

  /**
   *
   * @param eventQueue Event queue instance
   * @param options Optional configuration (referral parsing, etc.)
   */
  constructor(
    eventQueue: IEventQueue,
    options?: Options,
    private readonly canAcceptEvent: () => boolean = () => true
  ) {
    this.eventQueue = eventQueue;
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
    const generation = this.generation;
    const shouldContinue = () =>
      generation === this.generation && this.canAcceptEvent();
    if (!shouldContinue()) return;

    let formoEvent;
    try {
      formoEvent = await this.eventFactory.create(
        _event,
        address,
        userId,
        shouldContinue
      );
    } catch (error) {
      if (error === EVENT_CREATION_CANCELLED) return;
      throw error;
    }

    // Reject work invalidated while enrichment was pending.
    if (!shouldContinue()) return;

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

  /** Drop any buffered events (consent withdrawal). Recoverable. */
  clear(): void {
    this.generation++;
    this.eventQueue.clear();
  }

  /** Terminal shutdown on teardown: nothing can be sent after this. */
  close(): void {
    this.generation++;
    this.eventQueue.close();
  }
}

export { EventManager };
