export interface RequestEvent {
  action: string;
  payload: Record<string, unknown>;
  address: string | null;
  timestamp: string;
  version: string;
}

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
