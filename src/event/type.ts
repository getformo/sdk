import { Address, APIEvent, IFormoEvent } from "../types";

export interface IEventManager {
  addEvent(event: APIEvent, address?: Address, userId?: string): Promise<void>;
}

export interface IEventFactory {
  create(
    event: APIEvent,
    address?: Address,
    userId?: string
  ): Promise<IFormoEvent>;
}
