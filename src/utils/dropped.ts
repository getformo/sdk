import type { EventCallback } from "../types";

/** Why an event was not sent, one sentence per callback code. */
export const DROP_REASONS = {
  suppressed: "tracking is off for this visitor, environment, or chain",
  duplicate: "an identical event was already accepted",
  consent_withdrawn: "consent was withdrawn before delivery",
  closed: "the SDK was cleaned up before delivery",
  blocked: "the address is blocked",
  invalid_key: "the idempotency_key must be a non-empty string or a safe integer",
  invalid: "the call carried a missing or invalid address or chain",
} as const;

export type DropCode = keyof typeof DROP_REASONS;

/** The error handed to the callback of a dropped event. */
export function dropError(code: DropCode): Error & { code: DropCode } {
  return Object.assign(new Error(`Event not sent: ${DROP_REASONS[code]}`), { code });
}

/** Answer a callback for a dropped event; silence would read as success. */
export function answerDropped(
  callback: EventCallback | undefined,
  message: unknown,
  code: DropCode
): void {
  if (!callback) return;
  try {
    callback(dropError(code), message, []);
  } catch {
    /* a throwing callback is the host's bug */
  }
}
