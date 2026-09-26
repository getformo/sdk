// `@formo/analytics/replay`: session replay bundled with the app instead of
// loaded from a CDN. Importing this entry is what pulls the recorder in, so
// apps that never import it pay nothing for replay.
//
//   import { record } from "@rrweb/record";
//   import { replay } from "@formo/analytics/replay";
//
//   formo.init(WRITE_KEY, { replay: replay({ record }) });

import { createReplayRecorder } from "./ReplayRecorder";
import { RecordFn, ReplayOptions } from "./types";

export function replay(
  options: Omit<ReplayOptions, "record" | "recorder" | "scriptUrl"> & {
    record: RecordFn;
  }
): ReplayOptions {
  return { ...options, recorder: createReplayRecorder };
}

export { createReplayRecorder };
export type { RecordFn, ReplayOptions } from "./types";
