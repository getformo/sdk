import { describe, it } from "mocha";
import { expect } from "chai";
import {
  isFunction,
  isString,
  isNull,
  isUndefined,
  isNullOrUndefined,
  isBigInt,
  isDefined,
  isDefinedAndNotNull,
  isDefinedNotNullAndNotEmptyString,
  isTypeOfError,
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
} from "../../src/validators/checks";

describe("Type Check Validators", () => {
  describe("isFunction", () => {
    it("should return true for functions", () => {
      expect(isFunction(() => {})).to.be.true;
      expect(isFunction(function () {})).to.be.true;
      expect(isFunction(async () => {})).to.be.true;
      expect(isFunction(class {})).to.be.true;
    });

    it("should return false for non-functions", () => {
      expect(isFunction("string")).to.be.false;
      expect(isFunction(123)).to.be.false;
      expect(isFunction({})).to.be.false;
      expect(isFunction([])).to.be.false;
      expect(isFunction(null)).to.be.false;
      expect(isFunction(undefined)).to.be.false;
    });
  });

  describe("isString", () => {
    it("should return true for strings", () => {
      expect(isString("")).to.be.true;
      expect(isString("hello")).to.be.true;
      expect(isString(`template`)).to.be.true;
    });

    it("should return false for non-strings", () => {
      expect(isString(123)).to.be.false;
      expect(isString({})).to.be.false;
      expect(isString(null)).to.be.false;
      expect(isString(undefined)).to.be.false;
      expect(isString([])).to.be.false;
    });
  });

  describe("isNull", () => {
    it("should return true for null", () => {
      expect(isNull(null)).to.be.true;
    });

    it("should return false for non-null values", () => {
      expect(isNull(undefined)).to.be.false;
      expect(isNull("")).to.be.false;
      expect(isNull(0)).to.be.false;
      expect(isNull(false)).to.be.false;
      expect(isNull({})).to.be.false;
    });
  });

  describe("isUndefined", () => {
    it("should return true for undefined", () => {
      expect(isUndefined(undefined)).to.be.true;
      let x;
      expect(isUndefined(x)).to.be.true;
    });

    it("should return false for defined values", () => {
      expect(isUndefined(null)).to.be.false;
      expect(isUndefined("")).to.be.false;
      expect(isUndefined(0)).to.be.false;
      expect(isUndefined(false)).to.be.false;
    });
  });

  describe("isNullOrUndefined", () => {
    it("should return true for null or undefined", () => {
      expect(isNullOrUndefined(null)).to.be.true;
      expect(isNullOrUndefined(undefined)).to.be.true;
    });

    it("should return false for other values", () => {
      expect(isNullOrUndefined("")).to.be.false;
      expect(isNullOrUndefined(0)).to.be.false;
      expect(isNullOrUndefined(false)).to.be.false;
      expect(isNullOrUndefined({})).to.be.false;
    });
  });

  describe("isBigInt", () => {
    it("should return true for BigInt values", () => {
      expect(isBigInt(BigInt(123))).to.be.true;
      expect(isBigInt(BigInt("999999999999999999999999"))).to.be.true;
      expect(isBigInt(BigInt(0))).to.be.true;
    });

    it("should return false for non-BigInt values", () => {
      expect(isBigInt(123)).to.be.false;
      expect(isBigInt("123")).to.be.false;
      expect(isBigInt(null)).to.be.false;
    });
  });

  describe("isDefined", () => {
    it("should return true for defined values", () => {
      expect(isDefined(null)).to.be.true;
      expect(isDefined("")).to.be.true;
      expect(isDefined(0)).to.be.true;
      expect(isDefined(false)).to.be.true;
      expect(isDefined({})).to.be.true;
    });

    it("should return false for undefined", () => {
      expect(isDefined(undefined)).to.be.false;
    });
  });

  describe("isDefinedAndNotNull", () => {
    it("should return true for defined, non-null values", () => {
      expect(isDefinedAndNotNull("")).to.be.true;
      expect(isDefinedAndNotNull(0)).to.be.true;
      expect(isDefinedAndNotNull(false)).to.be.true;
      expect(isDefinedAndNotNull({})).to.be.true;
    });

    it("should return false for null or undefined", () => {
      expect(isDefinedAndNotNull(null)).to.be.false;
      expect(isDefinedAndNotNull(undefined)).to.be.false;
    });
  });

  describe("isDefinedNotNullAndNotEmptyString", () => {
    it("should return true for non-empty defined values", () => {
      expect(isDefinedNotNullAndNotEmptyString("hello")).to.be.true;
      expect(isDefinedNotNullAndNotEmptyString(0)).to.be.true;
      expect(isDefinedNotNullAndNotEmptyString(false)).to.be.true;
      expect(isDefinedNotNullAndNotEmptyString({})).to.be.true;
    });

    it("should return false for null, undefined, or empty string", () => {
      expect(isDefinedNotNullAndNotEmptyString(null)).to.be.false;
      expect(isDefinedNotNullAndNotEmptyString(undefined)).to.be.false;
      expect(isDefinedNotNullAndNotEmptyString("")).to.be.false;
    });
  });

  describe("isTypeOfError", () => {
    it("should return true for Error instances", () => {
      expect(isTypeOfError(new Error("test"))).to.be.true;
      expect(isTypeOfError(new TypeError("test"))).to.be.true;
      expect(isTypeOfError(new RangeError("test"))).to.be.true;
    });

    it("should return false for non-Error values", () => {
      expect(isTypeOfError("error")).to.be.false;
      expect(isTypeOfError({ message: "error" })).to.be.false;
      expect(isTypeOfError(null)).to.be.false;
    });
  });

  describe("isArray", () => {
    it("should return true for arrays", () => {
      expect(isArray([])).to.be.true;
      expect(isArray([1, 2, 3])).to.be.true;
      expect(isArray(new Array())).to.be.true;
    });

    it("should return false for non-arrays", () => {
      expect(isArray({})).to.be.false;
      expect(isArray("array")).to.be.false;
      expect(isArray(null)).to.be.false;
      expect(isArray({ length: 0 })).to.be.false; // Array-like object
    });
  });

  describe("isBoolean", () => {
    it("should return true for booleans", () => {
      expect(isBoolean(true)).to.be.true;
      expect(isBoolean(false)).to.be.true;
    });

    it("should return false for non-booleans", () => {
      expect(isBoolean(0)).to.be.false;
      expect(isBoolean(1)).to.be.false;
      expect(isBoolean("true")).to.be.false;
      expect(isBoolean(null)).to.be.false;
    });
  });

  describe("isNumber", () => {
    it("should return true for numbers", () => {
      expect(isNumber(0)).to.be.true;
      expect(isNumber(123)).to.be.true;
      expect(isNumber(-456)).to.be.true;
      expect(isNumber(3.14)).to.be.true;
      expect(isNumber(NaN)).to.be.true; // NaN is typeof number
      expect(isNumber(Infinity)).to.be.true;
    });

    it("should return false for non-numbers", () => {
      expect(isNumber("123")).to.be.false;
      expect(isNumber(null)).to.be.false;
      expect(isNumber(undefined)).to.be.false;
      expect(isNumber(BigInt(123))).to.be.false;
    });
  });

  describe("isObject", () => {
    it("should return true for objects", () => {
      expect(isObject({})).to.be.true;
      expect(isObject({ key: "value" })).to.be.true;
      expect(isObject([])).to.be.true; // Arrays are objects
      expect(isObject(null)).to.be.true; // null is typeof object
      expect(isObject(new Date())).to.be.true;
    });

    it("should return false for non-objects", () => {
      expect(isObject("string")).to.be.false;
      expect(isObject(123)).to.be.false;
      expect(isObject(undefined)).to.be.false;
      expect(isObject(() => {})).to.be.false;
    });
  });

  describe("isObjectAndNotNull", () => {
    it("should return true for non-null, non-array objects", () => {
      expect(isObjectAndNotNull({})).to.be.true;
      expect(isObjectAndNotNull({ key: "value" })).to.be.true;
      expect(isObjectAndNotNull(new Date())).to.be.true;
    });

    it("should return false for null, arrays, and primitives", () => {
      expect(isObjectAndNotNull(null)).to.be.false;
      expect(isObjectAndNotNull([])).to.be.false;
      expect(isObjectAndNotNull("string")).to.be.false;
      expect(isObjectAndNotNull(123)).to.be.false;
    });
  });

  describe("isRegExp", () => {
    it("should return true for RegExp", () => {
      expect(isRegExp(/test/)).to.be.true;
      expect(isRegExp(new RegExp("test"))).to.be.true;
      expect(isRegExp(/test/gi)).to.be.true;
    });

    it("should return false for non-RegExp", () => {
      expect(isRegExp("/test/")).to.be.false;
      expect(isRegExp({})).to.be.false;
      expect(isRegExp(null)).to.be.false;
    });
  });

  describe("isDate", () => {
    it("should return true for Date objects", () => {
      expect(isDate(new Date())).to.be.true;
      expect(isDate(new Date("2024-01-01"))).to.be.true;
    });

    it("should return false for non-Date values", () => {
      expect(isDate("2024-01-01")).to.be.false;
      expect(isDate(Date.now())).to.be.false;
      expect(isDate({})).to.be.false;
      expect(isDate(null)).to.be.false;
    });
  });

  describe("isError", () => {
    it("should return true for Error instances", () => {
      expect(isError(new Error())).to.be.true;
      expect(isError(new TypeError())).to.be.true;
      expect(isError(new SyntaxError())).to.be.true;
    });

    it("should return false for non-Error values", () => {
      expect(isError({ message: "error" })).to.be.false;
      expect(isError("error")).to.be.false;
      expect(isError(null)).to.be.false;
    });
  });

  describe("isPrimitive", () => {
    it("should return true for primitives", () => {
      expect(isPrimitive(null)).to.be.true;
      expect(isPrimitive(undefined)).to.be.true;
      expect(isPrimitive(true)).to.be.true;
      expect(isPrimitive(false)).to.be.true;
      expect(isPrimitive(123)).to.be.true;
      expect(isPrimitive("string")).to.be.true;
      expect(isPrimitive(Symbol("sym"))).to.be.true;
    });

    it("should return false for non-primitives", () => {
      expect(isPrimitive({})).to.be.false;
      expect(isPrimitive([])).to.be.false;
      expect(isPrimitive(() => {})).to.be.false;
      expect(isPrimitive(new Date())).to.be.false;
    });
  });

  describe("objectToString", () => {
    it("should return correct string representation", () => {
      expect(objectToString({})).to.equal("[object Object]");
      expect(objectToString([])).to.equal("[object Array]");
      expect(objectToString(new Date())).to.equal("[object Date]");
      expect(objectToString(/test/)).to.equal("[object RegExp]");
      expect(objectToString(null)).to.equal("[object Null]");
      expect(objectToString(undefined)).to.equal("[object Undefined]");
      expect(objectToString("string")).to.equal("[object String]");
      expect(objectToString(123)).to.equal("[object Number]");
    });
  });
});
