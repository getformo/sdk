import { session } from "../storage";
import { generateNativeUUID } from "../utils/generate";
import {
  REPLAY_IDLE_TIMEOUT_MS,
  REPLAY_MAX_DURATION_MS,
  REPLAY_SESSION_KEY,
} from "./constants";

/**
 * One replay per browser tab. sessionStorage keeps it across reloads and
 * multi-page navigation in that tab, and gives each new tab its own replay,
 * because each tab needs its own full DOM snapshot anyway.
 */
export interface ReplaySessionState {
  id: string;
  /** The sampling decision, kept for the replay's lifetime. */
  sampled: boolean;
  startedAt: number;
  lastActivityAt: number;
  /** Index of the next chunk to send. */
  nextChunk: number;
}

export function isReplaySessionExpired(
  state: ReplaySessionState,
  now: number
): boolean {
  return (
    now - state.lastActivityAt > REPLAY_IDLE_TIMEOUT_MS ||
    now - state.startedAt > REPLAY_MAX_DURATION_MS
  );
}

function isReplaySessionState(value: unknown): value is ReplaySessionState {
  const state = value as ReplaySessionState;
  return (
    !!state &&
    typeof state === "object" &&
    typeof state.id === "string" &&
    typeof state.sampled === "boolean" &&
    typeof state.startedAt === "number" &&
    typeof state.lastActivityAt === "number" &&
    typeof state.nextChunk === "number"
  );
}

export function loadReplaySession(): ReplaySessionState | undefined {
  try {
    const stored = session().get(REPLAY_SESSION_KEY);
    const parsed = typeof stored === "string" ? JSON.parse(stored) : stored;
    return isReplaySessionState(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function saveReplaySession(state: ReplaySessionState): void {
  try {
    session().set(REPLAY_SESSION_KEY, JSON.stringify(state));
  } catch {
    // Storage can be full or blocked. The replay still runs for this page.
  }
}

export function clearReplaySession(): void {
  try {
    session().remove(REPLAY_SESSION_KEY);
  } catch {
    /* nothing stored */
  }
}

export function createReplaySession(
  sampleRate: number,
  now: number
): ReplaySessionState {
  const rate = Math.min(1, Math.max(0, sampleRate));
  return {
    id: generateNativeUUID(),
    sampled: Math.random() < rate,
    startedAt: now,
    lastActivityAt: now,
    nextChunk: 0,
  };
}
