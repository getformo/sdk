import { IFormoIngestRow } from "../types";

export interface IEventQueue {
  enqueue(
    event: IFormoIngestRow,
    callback?: (...args: any) => void
  ): Promise<void>;
  flush(callback?: (...args: any) => void): Promise<any>;
  // Drop all buffered events on consent withdrawal / teardown. Part of
  // the queue contract — a custom queue must not silently skip it.
  clear(): void;
}
