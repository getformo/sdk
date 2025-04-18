import { UUID } from "crypto";
import { APIEvent, IFormoEvent } from "../../types";

export interface IEventFactory {
  create(
    anonymous_id: UUID,
    user_id: string | null,
    address: string | null,
    event: APIEvent
  ): IFormoEvent;
}
