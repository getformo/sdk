import { UUID } from "crypto";

export interface RequestEvent {
  anonymous_id: UUID;
  user_id: UUID | null;
  action: string;
  payload: Record<string, unknown>;
  address: string | null;
  timestamp: string;
  version: string;
}

export type RequestEventPayload = RequestEvent & {
  id: string;
};

export enum SignatureStatus {
  REQUESTED = "requested",
  REJECTED = "rejected",
  CONFIRMED = "confirmed",
}

export enum TransactionStatus {
  STARTED = "started",
  REJECTED = "rejected",
  BROADCASTED = "broadcasted",
}
