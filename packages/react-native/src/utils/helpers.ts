/**
 * Clamp a number between min and max values
 */
export function clampNumber(value: number, max: number, min: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Check if value is undefined
 */
export function isUndefined(value: unknown): value is undefined {
  return value === undefined;
}

/**
 * Convert object keys to snake_case
 */
export function toSnakeCase<T extends Record<string, unknown>>(obj: T): T {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    const snakeKey = key.replace(/([A-Z])/g, "_$1").toLowerCase();

    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      result[snakeKey] = toSnakeCase(value as Record<string, unknown>);
    } else {
      result[snakeKey] = value;
    }
  }

  return result as T;
}

/**
 * Deep merge two objects
 */
export function mergeDeepRight<T extends Record<string, unknown>>(
  target: T,
  source: Partial<T>
): T {
  const output = { ...target };

  for (const key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      const sourceValue = source[key];
      const targetValue = output[key];

      if (
        sourceValue !== null &&
        typeof sourceValue === "object" &&
        !Array.isArray(sourceValue) &&
        targetValue !== null &&
        typeof targetValue === "object" &&
        !Array.isArray(targetValue)
      ) {
        output[key] = mergeDeepRight(
          targetValue as Record<string, unknown>,
          sourceValue as Record<string, unknown>
        ) as T[Extract<keyof T, string>];
      } else if (sourceValue !== undefined) {
        output[key] = sourceValue as T[Extract<keyof T, string>];
      }
    }
  }

  return output;
}

/**
 * Get action descriptor for logging
 */
export function getActionDescriptor(
  type: string,
  properties?: Record<string, unknown> | null
): string {
  if (type === "track" && properties?.event) {
    return `track:${properties.event}`;
  }
  if (type === "screen" && properties?.name) {
    return `screen:${properties.name}`;
  }
  return type;
}

/**
 * Check if error is a network error
 */
export function isNetworkError(error: unknown): boolean {
  if (!error) return false;

  const message = error instanceof Error ? error.message : String(error);
  const networkErrorMessages = [
    "Network request failed",
    "Failed to fetch",
    "Network Error",
    "timeout",
    "ETIMEDOUT",
    "ECONNREFUSED",
    "ENOTFOUND",
  ];

  return networkErrorMessages.some((msg) =>
    message.toLowerCase().includes(msg.toLowerCase())
  );
}
