/**
 * Keep analytics JSON readable by integer-limited downstream parsers.
 * String encoding survives gateway parse/stringify round trips. This does not
 * validate business values or recover precision already lost by JavaScript.
 * Retains native JSON behavior (including toJSON, non-finite values and errors).
 */
export function stringifyAnalyticsJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "object" && item !== null) {
      // Ordinary objects/arrays must not throw once per queue traversal node.
      // Skip tag inspection when a custom tag exists: it can be spoofed or have
      // a getter. The internal-slot check below handles those without reading it.
      try {
        if (
          !(Symbol.toStringTag in item) &&
          Object.prototype.toString.call(item) !== "[object Number]"
        ) {
          return item;
        }
        // Definitive check for candidates, including cross-realm/tagged boxes.
        Number.prototype.valueOf.call(item);
      } catch {
        return item;
      }
      // Match JSON's ToNumber conversion (including custom primitive hooks).
      // Return the primitive so JSON does not invoke those hooks a second time.
      item = +(item as unknown as number);
    }
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
