import {
  Address,
  APIEvent,
  IFormoEvent,
  IFormoEventContext,
  IFormoEventProperties,
  IFormoLabelRow,
  IFormoProfileRow,
  Nullable,
} from "../types";

export interface IEventManager {
  addEvent(event: APIEvent, address?: Address, userId?: string): Promise<void>;
  addProfile(
    properties: IFormoEventProperties,
    address?: Nullable<Address>,
    userId?: Nullable<string>,
    context?: IFormoEventContext
  ): Promise<void>;
  addLabels(
    labels: IFormoEventProperties,
    address?: Nullable<Address>,
    userId?: Nullable<string>,
    context?: IFormoEventContext
  ): Promise<void>;
  clear(): void;
}

export interface IEventFactory {
  create(
    event: APIEvent,
    address?: Address,
    userId?: string
  ): Promise<IFormoEvent>;
  createProfile(
    properties: IFormoEventProperties,
    address?: Nullable<Address>,
    userId?: Nullable<string>,
    context?: IFormoEventContext
  ): Promise<IFormoProfileRow>;
  createLabels(
    labels: IFormoEventProperties,
    address?: Nullable<Address>,
    userId?: Nullable<string>,
    context?: IFormoEventContext
  ): Promise<IFormoLabelRow>;
}
