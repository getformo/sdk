import { Address, APIEvent, IFormoEvent } from "../types";


export interface IEventManager {
  addEvent(event: APIEvent, address?: Address, userId?: string): Promise<void>;
  clear(): void;
  close(): void;
  /** Build an event without queueing it. Session replay sends its own. */
  createEvent(event: APIEvent, address?: Address, userId?: string): Promise<IFormoEvent>;
  redactUrl(href: string): string;
}

export interface IEventFactory {
  invalidate(): void;
  redactUrl(href: string): string;
  create(
    event: APIEvent,
    address?: Address,
    userId?: string
  ): Promise<IFormoEvent>;
}
