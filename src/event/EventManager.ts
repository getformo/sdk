import { Address, APIEvent, Options } from "../types";
import { logger } from "../logger";
import { IEventQueue } from "../queue";
import { EventFactory } from "./EventFactory";
import { EVENT_CREATION_CANCELLED } from "./cancellation";
import { IEventFactory, IEventManager } from "./type";
import { isBlockedAddress } from "../utils/address";
import { hash } from "../utils";

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
    this.eventFactory = new EventFactory(options, () => this.canAcceptEvent());
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
    const { callback, ...eventWithoutCallback } = event;
    const { idempotencyKey, ..._event } = eventWithoutCallback as APIEvent & {
      idempotencyKey?: string;
    };
    const generation = this.generation;
    const shouldContinue = () =>
      generation === this.generation && this.canAcceptEvent();
    if (!shouldContinue()) return;

    let formoEvent;
    try {
      formoEvent = await this.eventFactory.create(_event, address, userId);
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

    const dedupKey =
      event.type === "track"
        ? hash(
            JSON.stringify({
              event: _event,
              address: address ?? null,
              userId: userId ?? null,
            })
          )
        : undefined;

    this.eventQueue.enqueue(
      formoEvent,
      (err, _, data) => {
        if (err) {
          logger.error("Error sending events:", err);
        } else logger.info(`Events sent successfully: ${data.length} events`);
        callback?.(err, _, data);
      },
      { dedupKey, idempotencyKey }
    );
  }

  /** Drop any buffered events (consent withdrawal). Recoverable. */
  clear(): void {
    this.generation++;
    this.eventFactory.invalidate();
    this.eventQueue.clear();
  }

  /** Terminal shutdown on teardown: nothing can be sent after this. */
  close(): void {
    this.generation++;
    this.eventFactory.invalidate();
    this.eventQueue.close();
  }
}

export { EventManager };
