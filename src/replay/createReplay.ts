import { logger } from "../logger";
import { session } from "../storage";
import { IFormoEvent, IFormoEventProperties } from "../types/events";
import { generateNativeUUID } from "../utils/generate";
import { loadReplayBundle } from "./loadBundle";
import { ReplayBundle, ReplayController, ReplayOptions } from "./types";

/** What the SDK instance provides to its recorder. */
export interface ReplayHost {
  writeKey: string;
  apiHost: string;
  canSend: () => boolean;
  canRecord: () => boolean;
  createEnvelope: (properties: IFormoEventProperties) => Promise<IFormoEvent>;
  redactUrl: (href: string) => string;
}

/**
 * Build the recorder: the one bundled through `@formo/analytics/replay`, or
 * the CDN replay bundle, loaded now. This file is all of replay that lives
 * in the core SDK.
 */
export function createReplay(
  options: ReplayOptions,
  host: ReplayHost
): Promise<ReplayController> {
  const loaded: Promise<ReplayBundle> = options.recorder
    ? Promise.resolve({ createRecorder: options.recorder, record: options.record! })
    : loadReplayBundle(options.scriptUrl);
  return loaded.then((bundle) => bundle.createRecorder({
    ...host,
    options: { ...options, record: options.record ?? bundle.record },
    storage: session(),
    generateId: generateNativeUUID,
    logger,
  }));
}
