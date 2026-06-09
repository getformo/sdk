import { logger } from "../logger";

/**
 * Resolve the current IANA timezone (e.g. "Europe/London") via the Intl API.
 * Returns "" when the timezone cannot be resolved (e.g. Intl unavailable).
 */
const getTimezone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch (error) {
    logger.error("Error resolving timezone:", error);
    return "";
  }
};

export { getTimezone };
