import { EVENTS_API_REQUEST_HEADER } from "../constants";
import fetchWithRetry, { FetchRetryError } from "../fetch";
import { logger } from "../logger";
import { IFormoEvent, IFormoEventProperties } from "../types";
import { generateNativeUUID } from "../utils/generate";
import { isNetworkError } from "../validators";
import {
  REPLAY_FLUSH_INTERVAL_MS,
  REPLAY_GATE_TTL_MS,
  REPLAY_IDLE_PAUSE_MS,
  REPLAY_KEEPALIVE_MAX_CHARS,
  REPLAY_MAX_BUFFER_CHARS,
  RRWEB_EVENT_FULL_SNAPSHOT,
  RRWEB_EVENT_INCREMENTAL,
  RRWEB_EVENT_META,
  RRWEB_MOUSE_INTERACTION_CLICK,
  RRWEB_SOURCE_INPUT,
  RRWEB_SOURCE_MOUSE_INTERACTION,
  RRWEB_SOURCE_MOUSE_MOVE,
  RRWEB_SOURCE_SCROLL,
  RRWEB_SOURCE_TOUCH_MOVE,
} from "./constants";
import { encodeReplayData, ReplayEncoding } from "./encode";
import { loadRecorder } from "./loader";
import {
  clearReplaySession,
  createReplaySession,
  isReplaySessionExpired,
  loadReplaySession,
  ReplaySessionState,
  saveReplaySession,
} from "./session";
import { RecordFn, ReplayEvent, ReplayOptions } from "./types";

export interface ReplayRecorderDeps {
  writeKey: string;
  apiHost: string;
  options: ReplayOptions;
  /** Consent only. Gates every send. */
  canSend: () => boolean;
  /** Consent plus visitor and page exclusions. Gates what is recorded. */
  canRecord: () => boolean;
  /** Identity and context for a chunk, built the way every event is. */
  createEnvelope: (properties: IFormoEventProperties) => Promise<IFormoEvent>;
  /** The SDK's URL redaction, applied to the page URL rrweb records. */
  redactUrl: (href: string) => string;
}

/** Only real user input keeps a replay alive or wakes it from idle. */
function isUserInput(event: ReplayEvent): boolean {
  if (event.type !== RRWEB_EVENT_INCREMENTAL) return false;
  const source = event.data?.source;
  return (
    source === RRWEB_SOURCE_MOUSE_MOVE ||
    source === RRWEB_SOURCE_MOUSE_INTERACTION ||
    source === RRWEB_SOURCE_SCROLL ||
    source === RRWEB_SOURCE_INPUT ||
    source === RRWEB_SOURCE_TOUCH_MOVE
  );
}

function joinSelectors(base: string, extra?: string): string {
  return extra ? `${base}, ${extra}` : base;
}

function isRetryable(error: FetchRetryError | null, response: Response | null) {
  if (error && isNetworkError(error)) return true;
  const status = response?.status ?? error?.response?.status;
  if (!status) return false;
  return (status >= 500 && status <= 599) || status === 429;
}

/**
 * Records the page with rrweb and ships it to the events endpoint in chunks.
 *
 * Each chunk is one event of type "replay" in the regular event envelope, so
 * it rides the same endpoint, write key and `apiHost` proxy as every other
 * event. It bypasses the event queue: chunks are far larger than the queue's
 * batches, and must go out in order.
 */
export class ReplayRecorder {
  private state?: ReplaySessionState;
  private record?: RecordFn;
  private stopRecording?: () => void;
  private buffer: ReplayEvent[] = [];
  private bufferChars = 0;
  private flushTimer?: ReturnType<typeof setInterval>;
  private removeLeaveListeners?: () => void;
  /**
   * Timed flushes go out one at a time, in index order. The page-leave send
   * cannot wait and goes out of band; the reader orders by chunk_index.
   */
  private sending: Promise<void> = Promise.resolve();
  private snapshotFlushScheduled = false;
  /** Last envelope built, for the synchronous flush on page leave. */
  private template?: IFormoEvent;
  /** Bumped by stop(); an in-flight start() across a bump gives up. */
  private generation = 0;
  private starting = false;
  /** No user input for REPLAY_IDLE_PAUSE_MS: stop buffering DOM changes. */
  private paused = false;
  /** Set while this class asks rrweb for a snapshot, which it must keep. */
  private snapshotting = false;
  private gateOpen = true;
  private gateCheckedAt = 0;
  /** Events were dropped by the gate, so the next kept one needs a snapshot. */
  private gateDropped = false;
  private lastSavedActivityAt = 0;

  constructor(private readonly deps: ReplayRecorderDeps) {}

  /** The id of the replay being recorded, or undefined when not recording. */
  get replayId(): string | undefined {
    return this.stopRecording && this.state?.sampled ? this.state.id : undefined;
  }

  /** Begin recording, when consent, exclusions and sampling allow it. */
  async start(): Promise<void> {
    if (this.stopRecording || this.starting) return;
    if (typeof window === "undefined" || !this.deps.canRecord()) return;

    const state = this.resolveSession(Date.now());
    if (!state.sampled) {
      logger.info("Session replay: this tab is not in the sample");
      return;
    }

    this.starting = true;
    const generation = this.generation;
    try {
      const record =
        this.deps.options.record ?? (await loadRecorder(this.deps.options.scriptUrl));
      if (generation !== this.generation || !this.deps.canRecord()) return;
      this.record = record;
      this.begin();
    } catch (error) {
      logger.warn("Session replay: recorder unavailable", error);
    } finally {
      this.starting = false;
    }
  }

  /**
   * Stop recording. With `discard`, buffered events are dropped (consent
   * withdrawal). Without it, they are sent first (teardown).
   */
  stop(discard = false): void {
    this.generation++;
    try {
      if (discard) this.clearBuffer();
      else this.flushOnLeave();
    } catch (error) {
      logger.warn("Session replay: final chunk not sent", error);
    } finally {
      // Always stop, or rrweb and the flush timer outlive the instance.
      this.halt();
    }
  }

  /**
   * A new identity (logout, reset) starts a new replay: what follows may be
   * a different person on the same tab.
   */
  reset(): void {
    const wasRecording = !!this.stopRecording;
    if (wasRecording) {
      this.flush();
      this.halt();
    }
    this.state = undefined;
    clearReplaySession();
    if (wasRecording) void this.start();
  }

  private resolveSession(now: number): ReplaySessionState {
    const stored = this.state ?? loadReplaySession();
    if (stored && !isReplaySessionExpired(stored, now)) {
      this.state = stored;
    } else {
      this.state = createReplaySession(this.deps.options.sampleRate ?? 1, now);
      saveReplaySession(this.state);
    }
    return this.state;
  }

  private begin(): void {
    // A page load counts as activity: without this, a reload after a few
    // idle minutes would pause at once and drop the first snapshot.
    this.state!.lastActivityAt = Date.now();
    saveReplaySession(this.state!);
    this.paused = false;
    this.gateDropped = false;
    this.flushTimer = setInterval(() => this.flush(), REPLAY_FLUSH_INTERVAL_MS);
    this.removeLeaveListeners = this.onPageLeave(() => this.flushOnLeave());
    // Build an envelope now so a leave before the first timed flush can
    // still send synchronously.
    this.deps
      .createEnvelope({})
      .then((envelope) => {
        if (!this.template) this.template = envelope;
      })
      .catch(() => {});
    this.stopRecording = this.startRrweb();
  }

  private startRrweb(): (() => void) | undefined {
    const options = this.deps.options;
    try {
      return (
        this.record!({
          emit: (event: ReplayEvent) => this.onEmit(event),
          maskAllInputs: options.maskAllInputs ?? true,
          maskInputOptions: { password: true },
          maskTextSelector: joinSelectors("[data-formo-mask]", options.maskTextSelector),
          blockSelector: joinSelectors("[data-formo-block]", options.blockSelector),
          recordCanvas: false,
          collectFonts: false,
          inlineImages: false,
          slimDOMOptions: "all",
          sampling: { mousemove: 50, scroll: 150, media: 800, input: "last" },
          // A fresh full snapshot every 5 minutes bounds how far back the
          // player must read to render any moment.
          checkoutEveryNms: 5 * 60 * 1000,
        }) || (() => {})
      );
    } catch (error) {
      logger.error("Session replay: rrweb failed to start", error);
      return undefined;
    }
  }

  /** Stop rrweb, timers and listeners. Leaves the stored session in place. */
  private halt(): void {
    try {
      this.stopRecording?.();
    } catch (error) {
      logger.warn("Session replay: rrweb failed to stop", error);
    }
    this.stopRecording = undefined;
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = undefined;
    this.removeLeaveListeners?.();
    this.removeLeaveListeners = undefined;
  }

  /** Consent and exclusions, read at most once a second while recording. */
  private gate(now: number): boolean {
    if (now - this.gateCheckedAt >= REPLAY_GATE_TTL_MS) {
      this.gateCheckedAt = now;
      this.gateOpen = this.deps.canRecord();
    }
    return this.gateOpen;
  }

  private onEmit(event: ReplayEvent): void {
    if (this.snapshotting) {
      this.push(event);
      return;
    }
    const state = this.state;
    if (!state) return;
    const now = Date.now();

    // An excluded page, or withdrawn consent, is never recorded. Coming back
    // needs a new snapshot: the DOM changed while nothing was kept.
    if (!this.gate(now)) {
      this.gateDropped = true;
      return;
    }
    if (this.gateDropped) {
      this.gateDropped = false;
      this.takeFullSnapshot();
      return;
    }

    if (isUserInput(event)) {
      if (isReplaySessionExpired(state, now)) {
        // Rotate outside rrweb's callback: rotation stops and restarts it.
        setTimeout(() => this.rotate(), 0);
        return;
      }
      state.lastActivityAt = now;
      if (now - this.lastSavedActivityAt > REPLAY_FLUSH_INTERVAL_MS) {
        this.lastSavedActivityAt = now;
        saveReplaySession(state);
      }
      if (this.paused) {
        this.paused = false;
        this.takeFullSnapshot();
      }
    } else if (now - state.lastActivityAt > REPLAY_IDLE_PAUSE_MS) {
      this.paused = true;
    }
    if (this.paused) return;

    this.push(event);
  }

  private push(event: ReplayEvent): void {
    if (event.type === RRWEB_EVENT_META && typeof event.data?.href === "string") {
      event = { ...event, data: { ...event.data, href: this.deps.redactUrl(event.data.href) } };
    }
    this.buffer.push(event);
    this.bufferChars += JSON.stringify(event).length;
    if (this.bufferChars >= REPLAY_MAX_BUFFER_CHARS && !this.snapshotting) {
      this.flush();
    } else if (event.type === RRWEB_EVENT_FULL_SNAPSHOT) {
      this.scheduleSnapshotFlush();
    }
  }

  /**
   * Send a full snapshot as soon as rrweb has emitted it, gzipped. Without
   * this it could wait up to a flush interval and meet a page leave, whose
   * synchronous path cannot compress: an uncompressed snapshot is often past
   * the keepalive limit, the send is cancelled, and the replay is left with
   * nothing to render from.
   */
  private scheduleSnapshotFlush(): void {
    if (this.snapshotFlushScheduled) return;
    this.snapshotFlushScheduled = true;
    setTimeout(() => {
      this.snapshotFlushScheduled = false;
      if (this.stopRecording) this.flush();
    }, 0);
  }

  private takeFullSnapshot(): void {
    this.snapshotting = true;
    try {
      if (this.record?.takeFullSnapshot) {
        this.record.takeFullSnapshot(true);
      } else {
        // Older rrweb: restarting the recorder takes a snapshot too.
        this.stopRecording?.();
        this.stopRecording = this.startRrweb();
      }
    } catch (error) {
      logger.warn("Session replay: snapshot failed", error);
    } finally {
      this.snapshotting = false;
    }
    if (this.bufferChars >= REPLAY_MAX_BUFFER_CHARS) this.flush();
  }

  /** End the current replay and start a new one in the same tab. */
  private rotate(): void {
    // Several inputs can schedule a rotation before the first one runs.
    if (!this.stopRecording || !this.state) return;
    if (!isReplaySessionExpired(this.state, Date.now())) return;
    this.flush();
    this.halt();
    this.state = createReplaySession(this.deps.options.sampleRate ?? 1, Date.now());
    saveReplaySession(this.state);
    if (this.state.sampled) this.begin();
  }

  private clearBuffer(): void {
    this.buffer = [];
    this.bufferChars = 0;
  }

  /** Take the buffer as the next chunk. Undefined when there is nothing to send. */
  private takeChunk(): { replayId: string; chunkIndex: number; events: ReplayEvent[] } | undefined {
    const state = this.state;
    if (!state || !this.buffer.length) return undefined;
    if (!this.deps.canSend()) {
      this.clearBuffer();
      return undefined;
    }
    const events = this.buffer;
    this.clearBuffer();
    const chunkIndex = state.nextChunk++;
    saveReplaySession(state);
    return { replayId: state.id, chunkIndex, events };
  }

  private flush(): void {
    const chunk = this.takeChunk();
    if (!chunk) return;
    this.sending = this.sending
      .then(() => this.sendChunk(chunk.replayId, chunk.chunkIndex, chunk.events))
      .catch((error) => logger.warn("Session replay: chunk not sent", error));
  }

  private chunkProperties(
    replayId: string,
    chunkIndex: number,
    events: ReplayEvent[],
    encoding: ReplayEncoding,
    data: string
  ): IFormoEventProperties {
    let clicks = 0;
    let keypresses = 0;
    let hasFullSnapshot = false;
    for (const event of events) {
      if (event.type === RRWEB_EVENT_FULL_SNAPSHOT) hasFullSnapshot = true;
      if (event.type !== RRWEB_EVENT_INCREMENTAL) continue;
      if (
        event.data?.source === RRWEB_SOURCE_MOUSE_INTERACTION &&
        event.data?.type === RRWEB_MOUSE_INTERACTION_CLICK
      ) {
        clicks++;
      } else if (event.data?.source === RRWEB_SOURCE_INPUT) {
        keypresses++;
      }
    }
    return {
      replay_id: replayId,
      chunk_index: chunkIndex,
      first_timestamp: events[0].timestamp,
      last_timestamp: events[events.length - 1].timestamp,
      event_count: events.length,
      has_full_snapshot: hasFullSnapshot,
      click_count: clicks,
      keypress_count: keypresses,
      encoding,
      data,
    };
  }

  private async sendChunk(
    replayId: string,
    chunkIndex: number,
    events: ReplayEvent[]
  ): Promise<void> {
    const { encoding, data } = await encodeReplayData(JSON.stringify(events));
    const properties = this.chunkProperties(replayId, chunkIndex, events, encoding, data);
    // Throws when consent is withdrawn mid-build; the chunk is then dropped.
    const envelope = await this.deps.createEnvelope(properties);
    this.template = { ...envelope, properties: null };
    if (!this.deps.canSend()) return;
    await this.post(envelope, events[0].timestamp);
  }

  /**
   * The page may be gone before any promise settles, so this path is
   * synchronous: no compression, and the envelope comes from the last one
   * built. Small bodies go with keepalive, which outlives the page.
   */
  private flushOnLeave(): void {
    if (!this.template) {
      this.flush();
      return;
    }
    const chunk = this.takeChunk();
    if (!chunk) return;
    const json = JSON.stringify(chunk.events);
    const envelope: IFormoEvent = {
      ...this.template,
      context: {
        ...(this.template.context ?? {}),
        page_url: this.deps.redactUrl(globalThis.location.href),
      },
      properties: this.chunkProperties(
        chunk.replayId,
        chunk.chunkIndex,
        chunk.events,
        "json",
        json
      ),
    };
    void this.post(envelope, chunk.events[0].timestamp).catch((error) =>
      logger.warn("Session replay: chunk not sent on page leave", error)
    );
  }

  private async post(envelope: IFormoEvent, firstTimestamp: number): Promise<void> {
    const body = JSON.stringify([
      {
        ...envelope,
        original_timestamp: new Date(firstTimestamp).toISOString(),
        message_id: generateNativeUUID(),
        sent_at: new Date().toISOString(),
      },
    ]);
    const response = await fetchWithRetry(this.deps.apiHost, {
      method: "POST",
      headers: EVENTS_API_REQUEST_HEADER(this.deps.writeKey),
      body,
      keepalive: body.length <= REPLAY_KEEPALIVE_MAX_CHARS,
      retries: 2,
      retryDelay: (attempt) => Math.pow(2, attempt) * 1_000,
      retryOn: (_, error, response) => isRetryable(error, response),
    });
    if (!response.ok) {
      throw new Error(response.statusText || `HTTP ${response.status}`);
    }
  }

  private onPageLeave(handler: () => void): () => void {
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") handler();
    };
    // Captured once, so removal targets the objects listened on.
    const globalTarget = window;
    const documentTarget = document;
    globalTarget.addEventListener("pagehide", handler);
    documentTarget.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      globalTarget.removeEventListener("pagehide", handler);
      documentTarget.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }
}
