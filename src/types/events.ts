import { UUID } from "crypto";
import { Address, ChainID } from "./base";
import { EventType } from "../constants";

export interface IFormoEvent {
  type: EventType;
  anonymous_id: UUID;
  user_id: string | null;
  address: string | null;
  context: Record<string, unknown>;
  properties: Record<string, unknown>;
  timestamp: string;
  version: string;
}

export type IFormoEventPayload = IFormoEvent & {
  messageId: string;
};

export type APIEvent =
  | {
      type: "page_hit";
    }
  | {
      type: "detect_wallet";
      providerName: string;
      rdns: string;
    }
  | {
      type: "identify";
      address: string;
      providerName: string;
      rdns: string;
      userId?: string;
    }
  | {
      type: "chain_changed";
      chainId: ChainID;
      address: Address;
    }
  | {
      type: "transaction";
      status: TransactionStatus;
      chainId: ChainID;
      address: Address;
      data: string;
      to: string;
      value: string;
      transactionHash: string;
    }
  | {
      type: "signature";
      status: SignatureStatus;
      chainId: ChainID;
      address: Address;
      message: string;
      signatureHash: string;
    }
  | {
      type: "disconnect";
      chainId: ChainID;
      address: Address;
    }
  | {
      type: "connect";
      chainId: ChainID;
      address: Address;
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
