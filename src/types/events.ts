import { UUID } from "crypto";
import { Address, ChainID } from "./base";

export interface IFormoEvent {
  anonymous_id: UUID;
  user_id: string | null;
  action: string;
  payload: Record<string, unknown>;
  address: string | null;
  timestamp: string;
  version: string;
}

export type IFormoEventPayload = IFormoEvent & {
  id: string;
};

export type APIEvent =
  | {
      action: "page_hit";
    }
  | {
      action: "detect_wallet";
      providerName: string;
      rdns: string;
    }
  | {
      action: "identify";
      address: string;
      providerName: string;
      rdns: string;
      userId?: string;
    }
  | {
      action: "chain_changed";
      chainId: ChainID;
      address: Address;
    }
  | {
      action: "transaction";
      status: TransactionStatus;
      chainId: ChainID;
      address: Address;
      data: string;
      to: string;
      value: string;
      transactionHash: string;
    }
  | {
      action: "signature";
      status: SignatureStatus;
      chainId: ChainID;
      address: Address;
      message: string;
      signatureHash: string;
    }
  | {
      action: "disconnect";
      chainId: ChainID;
      address: Address;
    }
  | {
      action: "connect";
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
