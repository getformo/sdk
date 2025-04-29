import { UUID } from "crypto";
import { Address, ChainID, Nullable } from "./base";
import { TEventChannel, TEventType } from "../constants";

export type AnonymousID = UUID;

export interface ICommonProperties {
  anonymous_id: AnonymousID;
  user_id: Nullable<string>;
  address: Nullable<string>;
  type: TEventType;
  channel: TEventChannel;
  version: string;
  original_timestamp: string;
  event?: Nullable<string>;
}

export type IFormoEventProperties = Record<string, unknown>;
export type IFormoEventContext = Record<string, unknown>;
export type UTMParameters = {
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_term: string;
  utm_content: string;
};
export type ITrafficSource = UTMParameters & {
  ref: string;
  referrer: string;
};

export interface IFormoEvent extends ICommonProperties {
  context: Nullable<IFormoEventContext>;
  properties: Nullable<IFormoEventProperties>;
}

export type IFormoEventPayload = IFormoEvent & {
  message_id: string;
};

//#region Specific Event Types
export interface PageAPIEvent {
  type: "page";
  name?: string;
  category?: string;
}
export interface DetectAPIEvent {
  type: "detect";
  providerName: string;
  rdns: string;
}
export interface IdentifyAPIEvent {
  type: "identify";
  address: string;
  providerName: string;
  rdns: string;
  userId?: Nullable<string>;
}
export interface ChainAPIEvent {
  type: "chain";
  chainId: ChainID;
  address: Address;
}
export interface TransactionAPIEvent {
  type: "transaction";
  status: TransactionStatus;
  chainId: ChainID;
  address: Address;
  data: string;
  to: string;
  value: string;
  transactionHash: string;
}
export interface SignatureAPIEvent {
  type: "signature";
  status: SignatureStatus;
  chainId: ChainID;
  address: Address;
  message: string;
  signatureHash: string;
}
export interface ConnectAPIEvent {
  type: "connect";
  chainId: ChainID;
  address: Address;
}
export interface DisconnectAPIEvent {
  type: "disconnect";
  chainId: ChainID;
  address: Address;
}
export interface TrackAPIEvent {
  type: "track";
  event: string;
  revenue?: number;
  currency?: string;
  points?: number;
}

export type APIEvent = {
  properties?: IFormoEventProperties;
  context?: IFormoEventContext;
  callback?: (...args: unknown[]) => void;
} & (
  | PageAPIEvent
  | DetectAPIEvent
  | IdentifyAPIEvent
  | ChainAPIEvent
  | TransactionAPIEvent
  | SignatureAPIEvent
  | ConnectAPIEvent
  | DisconnectAPIEvent
  | TrackAPIEvent
);

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
