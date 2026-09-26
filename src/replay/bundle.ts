// Entry for dist/replay.umd.min.js: the recorder and rrweb in one file, which
// the core SDK loads from a CDN only when replay starts. It holds none of the
// core SDK: storage, transport and logging are passed in by the core.

import { record } from "@rrweb/record";
import { createReplayRecorder } from "./ReplayRecorder";
import { RecordFn, ReplayBundle } from "./types";

const bundle: ReplayBundle = {
  createRecorder: createReplayRecorder,
  record: record as unknown as RecordFn,
};

if (typeof window !== "undefined") window.FormoReplay = bundle;
