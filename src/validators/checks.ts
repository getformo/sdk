/**
 * A function to check given value is a function
 * @param value input value
 * @returns boolean
 */
const isFunction = (value: any): value is Function =>
  typeof value === "function" &&
  Boolean(value.constructor && value.call && value.apply);

/**
 * A function to check given value is a string
 * @param value input value
 * @returns boolean
 */
const isString = (value: any): value is string => typeof value === "string";

/**
 * A function to check given value is null or not
 * @param value input value
 * @returns boolean
 */
const isNull = (value: any): value is null => value === null;

/**
 * A function to check given value is undefined
 * @param value input value
 * @returns boolean
 */
const isUndefined = (value: any): value is undefined =>
  typeof value === "undefined";

/**
 * A function to check given value is null or undefined
 * @param value input value
 * @returns boolean
 */
const isNullOrUndefined = (value: any): boolean =>
  isNull(value) || isUndefined(value);

/**
 * Checks if the input is a BigInt
 * @param value input value
 * @returns True if the input is a BigInt
 */
const isBigInt = (value: any): value is bigint => typeof value === "bigint";

/**
 * A function to check given value is defined
 * @param value input value
 * @returns boolean
 */
const isDefined = (value: any): boolean => !isUndefined(value);

/**
 * A function to check given value is defined and not null
 * @param value input value
 * @returns boolean
 */
const isDefinedAndNotNull = (value: any): boolean => !isNullOrUndefined(value);

/**
 * A function to check given value is defined and not null
 * @param value input value
 * @returns boolean
 */
const isDefinedNotNullAndNotEmptyString = (value: any): boolean =>
  isDefinedAndNotNull(value) && value !== "";

/**
 * Determines if the input is of type error
 * @param value input value
 * @returns true if the input is of type error else false
 */
const isTypeOfError = (value: any): boolean => {
  switch (Object.prototype.toString.call(value)) {
    case "[object Error]":
    case "[object Exception]":
    case "[object DOMException]":
      return true;
    default:
      return value instanceof Error;
  }
};

/**
 * A function to check given value is an array
 * @param value input value
 * @returns true if the input is of type array else false
 */
const isArray = (arg: any): arg is Array<any> => {
  return Array.isArray(arg);
};

const isBoolean = (arg: any): arg is boolean => {
  return typeof arg === "boolean";
};

const isNumber = (arg: any): arg is number => {
  return typeof arg === "number";
};

const isObject = (value: any): value is object => typeof value === "object";

const isObjectAndNotNull = (value: any): value is object =>
  !isNull(value) && isObject(value) && !isArray(value);

const isRegExp = (arg: any): arg is RegExp => {
  return isObject(arg) && objectToString(arg) === "[object RegExp]";
};

const isDate = (arg: any): arg is Date => {
  return isObject(arg) && objectToString(arg) === "[object Date]";
};

const isError = (arg: any): arg is Error => {
  return (
    isObject(arg) &&
    (objectToString(arg) === "[object Error]" || arg instanceof Error)
  );
};

const isPrimitive = (
  arg: any
): arg is null | boolean | number | string | symbol | undefined => {
  return (
    arg === null ||
    typeof arg === "boolean" ||
    typeof arg === "number" ||
    typeof arg === "string" ||
    typeof arg === "symbol" || // ES6 symbol
    typeof arg === "undefined"
  );
};

const objectToString = (arg: any) => {
  return Object.prototype.toString.call(arg);
};

export {
  isFunction,
  isString,
  isNull,
  isUndefined,
  isNullOrUndefined,
  isTypeOfError,
  isDefined,
  isDefinedAndNotNull,
  isDefinedNotNullAndNotEmptyString,
  isBigInt,
  isArray,
  isBoolean,
  isNumber,
  isObject,
  isObjectAndNotNull,
  isRegExp,
  isDate,
  isError,
  isPrimitive,
  objectToString,
};
