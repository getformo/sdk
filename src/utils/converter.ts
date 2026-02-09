const toSnake = (str: string) =>
  str
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();

// Converts object keys to snake_case, omitting keys in the omitKeys array
export function toSnakeCase(obj: any, omitKeys: string[] = []) {
  const convert = (data: any): any => {
    if (Array.isArray(data)) {
      return data.map(convert); // Recursively handle array elements
    } else if (data !== null && typeof data === "object") {
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

export const toDateHourMinuteSecond = (date: Date) =>
  date.getUTCFullYear() +
  "-" +
  ("0" + (date.getUTCMonth() + 1)).slice(-2) +
  "-" +
  ("0" + date.getUTCDate()).slice(-2) +
  " " +
  ("0" + date.getUTCHours()).slice(-2) +
  ":" +
  ("0" + date.getUTCMinutes()).slice(-2) +
  ":" +
  ("0" + date.getUTCSeconds()).slice(-2);

export const clampNumber = (value: number, max: number, min: number) => {
  return Math.min(Math.max(value, min), max);
};
