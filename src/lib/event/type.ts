import { APIEvent, IFormoEvent } from "../../types";

export interface IEventManager {
  addEvent(event: APIEvent): void;
}

export interface IEventFactory {
  create(event: APIEvent): IFormoEvent;
}
