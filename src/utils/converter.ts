import { isUnsafeObjectKey } from "./safeKey";

const toSnake = (str: string) =>
  str
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();

// Hard recursion ceiling. Event properties/context are public SDK input;
// a deeply-nested or circular host object must not crash the analytics
// pipeline (stack overflow → event silently dropped). Beyond this depth
// the subtree is replaced with a marker instead of recursing.
const MAX_CONVERT_DEPTH = 64;

// Converts object keys to snake_case, omitting keys in the omitKeys array
export function toSnakeCase(obj: any, omitKeys: string[] = []) {
  // `seen` tracks the ancestor chain to break circular references
  // (which would otherwise recurse until a RangeError).
  const convert = (data: any, depth: number, seen: WeakSet<object>): any => {
    if (data !== null && typeof data === "object") {
      if (depth >= MAX_CONVERT_DEPTH) return "[MaxDepth]";
      if (seen.has(data)) return "[Circular]";
      seen.add(data);
      try {
        if (Array.isArray(data)) {
          return data.map((v) => convert(v, depth + 1, seen));
        }
        return Object.keys(data).reduce((acc: any, key) => {
          // If the key is in omitKeys, keep it as it is
          const resultKey = omitKeys.includes(key) ? key : toSnake(key);
          // Drop prototype-polluting keys: assigning `__proto__`/
          // `constructor`/`prototype` onto the plain accumulator would
          // mutate its prototype. Event properties/context are public
          // SDK inputs and may carry these as own keys via JSON.parse.
          if (isUnsafeObjectKey(key) || isUnsafeObjectKey(resultKey)) {
            return acc;
          }
          acc[resultKey] = omitKeys.includes(key)
            ? data[key]
            : convert(data[key], depth + 1, seen);
          return acc;
        }, {});
      } finally {
        // Sibling subtrees that legitimately share a reference are not
        // cycles — only ancestors count.
        seen.delete(data);
      }
    }
    return data;
  };

  return convert(obj, 0, new WeakSet<object>());
}

export const millisecondsToSecond = (milliseconds: number): number =>
  Math.ceil(milliseconds / 1_000);

export const toDateHourMinute = (date: Date) =>
  date.getUTCFullYear() +
  "-" +
  ("0" + (date.getUTCMonth() + 1)).slice(-2) +
  "-" +
  ("0" + date.getUTCDate()).slice(-2) +
  " " +
  ("0" + date.getUTCHours()).slice(-2) +
  ":" +
  ("0" + date.getUTCMinutes()).slice(-2);

export const clampNumber = (value: number, max: number, min: number) => {
  return Math.min(Math.max(value, min), max);
};
