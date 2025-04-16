export function isArray(arg: any) {
  return Array.isArray(arg);
}

export function isBoolean(arg: any) {
  return typeof arg === "boolean";
}

export function isNull(arg: any) {
  return arg === null;
}

export function isNumber(arg: any) {
  return typeof arg === "number";
}

export function isString(arg: any) {
  return typeof arg === "string";
}

export function isUndefined(arg: any) {
  return arg === void 0;
}

export function isRegExp(arg: any) {
  return isObject(arg) && objectToString(arg) === "[object RegExp]";
}

export function isObject(arg: any) {
  return typeof arg === "object" && arg !== null;
}

export function isDate(arg: any) {
  return isObject(arg) && objectToString(arg) === "[object Date]";
}

export function isError(arg: any) {
  return (
    isObject(arg) &&
    (objectToString(arg) === "[object Error]" || arg instanceof Error)
  );
}

export function isFunction$1(arg: any) {
  return typeof arg === "function";
}

export function isPrimitive(arg: any) {
  return (
    arg === null ||
    typeof arg === "boolean" ||
    typeof arg === "number" ||
    typeof arg === "string" ||
    typeof arg === "symbol" || // ES6 symbol
    typeof arg === "undefined"
  );
}

export function objectToString(arg: any) {
  return Object.prototype.toString.call(arg);
}
