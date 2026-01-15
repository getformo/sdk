import { IFormoEvent } from "../types";

export interface IEventQueue {
  enqueue(event: IFormoEvent, callback?: (...args: any) => void): Promise<void>;
  flush(callback?: (...args: any) => void): Promise<any>;
}
