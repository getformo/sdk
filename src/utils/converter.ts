const toSnake = (str: string) =>
  str
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();

/**
 * Recursively converts object keys from camelCase to snake_case.
 *
 * Only plain objects (those whose constructor is Object or whose prototype is null)
 * have their keys converted. Non-plain objects such as Date, Uint8Array, RegExp,
 * and class instances are returned as-is to prevent data corruption.
 *
 * @param obj - The value to convert. Primitives and non-plain objects pass through unchanged.
 * @param omitKeys - Keys to exclude from conversion (kept verbatim).
 */
export function toSnakeCase(obj: any, omitKeys: string[] = []) {
  const convert = (data: any): any => {
    if (Array.isArray(data)) {
      return data.map(convert); // Recursively handle array elements
    } else if (
      data !== null &&
      typeof data === "object" &&
      (data.constructor === Object || Object.getPrototypeOf(data) === null)
    ) {
      return Object.keys(data).reduce((acc: any, key) => {
        // If the key is in omitKeys, keep it as it is
        const resultKey = omitKeys.includes(key) ? key : toSnake(key);
        acc[resultKey] = omitKeys.includes(key)
          ? data[key]
          : convert(data[key]);
        return acc;
      }, {});
    }
    return data;
  };

  return convert(obj);
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
