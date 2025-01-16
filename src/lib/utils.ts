const toSnake = (str: string) =>
  str
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();

// Converts object keys to snake_case, omitting keys in the omitKeys array
export function toSnakeCase(obj: any, omitKeys: string[] = []) {
  const convert = (data: any): any => {
    if (Array.isArray(obj)) {
      return obj.map(convert);
    } else if (obj !== null && typeof obj === "object") {
      return Object.keys(obj).reduce((acc: any, key) => {
        // If the key is in omitKeys, keep it as it is
        const resultKey = omitKeys.includes(key) ? key : toSnake(key);
        acc[resultKey] = omitKeys.includes(key) ? obj[key] : convert(obj[key]);
        return acc;
      }, {});
    }
    return data;
  };

  return convert(obj);
}
