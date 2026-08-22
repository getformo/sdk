import { IFormoEvent } from "../types";

export interface IEventQueue {
  enqueue(event: IFormoEvent, callback?: (...args: any) => void): Promise<void>;
  flush(callback?: (...args: any) => void): Promise<any>;
  // Drop all buffered events on consent withdrawal. Part of the queue
  // contract — a custom queue must not silently skip it. Recoverable: the
  // queue accepts events again afterwards.
  clear(): void;
  // Terminal shutdown on SDK teardown. After this, enqueue() must be a
  // no-op forever, so an async continuation that outlives the instance can
  // never send. See EventQueue.close().
  close(): void;
}
