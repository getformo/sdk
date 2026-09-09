/**
 * Keep analytics JSON readable by integer-limited downstream parsers.
 * String encoding survives gateway parse/stringify round trips. This does not
 * validate business values or recover precision already lost by JavaScript.
 * Retains native JSON behavior (including toJSON, non-finite values and errors).
 */
export function stringifyAnalyticsJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (
      typeof item === "number" &&
      Number.isInteger(item) &&
      // JSON prints -2^63 as -9223372036854776000, below Int64 minimum.
      (item >= 2 ** 64 || item <= -(2 ** 63))
    ) {
      return String(item);
    }
    return item;
  });
}
