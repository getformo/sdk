/**
 * Pinned rrweb recorder for script-tag installs. The UMD build defines
 * `window.rrwebRecord`. The integrity hash was taken from the npm tarball of
 * the same version and matches the file jsDelivr serves.
 */
export const REPLAY_SCRIPT_URL =
  "https://cdn.jsdelivr.net/npm/@rrweb/record@2.1.6/umd/record.min.js";
export const REPLAY_SCRIPT_INTEGRITY =
  "sha384-UXg/O1bVryk2M3h7gqexGANyLz+zFnrl1KWPxii4mUPP42AwGp1LvfeGjURH/0F9";

/** sessionStorage key for the current tab's replay. */
export const REPLAY_SESSION_KEY = "replay-session";

/** A gap without user input longer than this starts a new replay. */
export const REPLAY_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
/** A replay is cut into a new one after this long, however active. */
export const REPLAY_MAX_DURATION_MS = 24 * 60 * 60 * 1000;
/**
 * After this long without user input, DOM changes are no longer buffered.
 * A price ticker left open in a background tab would otherwise stream
 * mutations for hours. The next input takes a fresh full snapshot.
 */
export const REPLAY_IDLE_PAUSE_MS = 5 * 60 * 1000;

export const REPLAY_FLUSH_INTERVAL_MS = 5_000;
/** Flush early once the buffer holds this many JSON characters. */
export const REPLAY_MAX_BUFFER_CHARS = 512 * 1024;
/** How often the consent / exclusion gate is re-read while recording. */
export const REPLAY_GATE_TTL_MS = 1_000;
/** Bodies under this size may use keepalive (the browser cap is 64KB total). */
export const REPLAY_KEEPALIVE_MAX_CHARS = 60 * 1024;

/** rrweb event and source numbers used below (from @rrweb/types). */
export const RRWEB_EVENT_FULL_SNAPSHOT = 2;
export const RRWEB_EVENT_INCREMENTAL = 3;
export const RRWEB_EVENT_META = 4;
export const RRWEB_SOURCE_MOUSE_MOVE = 1;
export const RRWEB_SOURCE_MOUSE_INTERACTION = 2;
export const RRWEB_SOURCE_SCROLL = 3;
export const RRWEB_SOURCE_INPUT = 5;
export const RRWEB_SOURCE_TOUCH_MOVE = 6;
export const RRWEB_MOUSE_INTERACTION_CLICK = 2;
