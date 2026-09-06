import { Address, APIEvent, IFormoEvent } from "../types";


export interface IEventManager {
  addEvent(event: APIEvent, address?: Address, userId?: string): Promise<void>;
  clear(): void;
  close(): void;
}

export interface IEventFactory {
  invalidate(): void;
  create(
    event: APIEvent,
    address?: Address,
    userId?: string
  ): Promise<IFormoEvent>;
}
