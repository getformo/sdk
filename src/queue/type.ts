import { IFormoEvent } from "../types";

export interface IEventQueue {
  enqueue(event: IFormoEvent, callback?: (...args: any) => void): Promise<void>;
  flush(callback?: (...args: any) => void): Promise<any>;
  // Optional: implemented by the real queue to drop buffered events on
  // consent withdrawal / teardown. Optional so lightweight test doubles
  // don't have to stub it; callers must invoke it defensively.
  clear?(): void;
}
