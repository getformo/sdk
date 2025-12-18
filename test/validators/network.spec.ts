import { describe, it } from "mocha";
import { expect } from "chai";
import { isNetworkError } from "../../src/validators/network";

describe("isNetworkError", () => {
  describe("valid network errors", () => {
    it("should return true for Chrome network error", () => {
      const error = new TypeError("network error");
      expect(isNetworkError(error)).to.be.true;
    });

    it("should return true for Chrome fetch failed", () => {
      const error = new TypeError("Failed to fetch");
      expect(isNetworkError(error)).to.be.true;
    });

    it("should return true for Firefox network error", () => {
      const error = new TypeError(
        "NetworkError when attempting to fetch resource."
      );
      expect(isNetworkError(error)).to.be.true;
    });

    it("should return true for Safari 16 offline error", () => {
      const error = new TypeError(
        "The Internet connection appears to be offline."
      );
      expect(isNetworkError(error)).to.be.true;
    });

    it("should return true for Safari 17+ load failed (without stack)", () => {
      const error = new TypeError("Load failed");
      // Safari 17+ network errors have no stack
      Object.defineProperty(error, "stack", { value: undefined });
      expect(isNetworkError(error)).to.be.true;
    });

    it("should return true for cross-fetch network error", () => {
      const error = new TypeError("Network request failed");
      expect(isNetworkError(error)).to.be.true;
    });

    it("should return true for Undici fetch failed", () => {
      const error = new TypeError("fetch failed");
      expect(isNetworkError(error)).to.be.true;
    });

    it("should return true for Undici terminated", () => {
      const error = new TypeError("terminated");
      expect(isNetworkError(error)).to.be.true;
    });
  });

  describe("non-network errors", () => {
    it("should return false for Safari 17+ load failed (with stack)", () => {
      const error = new TypeError("Load failed");
      // Regular errors have a stack trace
      expect(error.stack).to.not.be.undefined;
      expect(isNetworkError(error)).to.be.false;
    });

    it("should return false for non-TypeError", () => {
      const error = new Error("network error");
      expect(isNetworkError(error)).to.be.false;
    });

    it("should return false for TypeError with different message", () => {
      const error = new TypeError("Cannot read property 'x' of undefined");
      expect(isNetworkError(error)).to.be.false;
    });

    it("should return false for null", () => {
      expect(isNetworkError(null)).to.be.false;
    });

    it("should return false for undefined", () => {
      expect(isNetworkError(undefined)).to.be.false;
    });

    it("should return false for string", () => {
      expect(isNetworkError("network error")).to.be.false;
    });

    it("should return false for plain object", () => {
      expect(isNetworkError({ message: "network error", name: "TypeError" })).to
        .be.false;
    });

    it("should return false for non-string message", () => {
      const error = new TypeError();
      (error as any).message = 123;
      expect(isNetworkError(error)).to.be.false;
    });

    it("should return false for random TypeError messages", () => {
      const messages = [
        "null is not an object",
        "undefined is not a function",
        "Cannot convert undefined or null to object",
        "Assignment to constant variable",
      ];

      messages.forEach((message) => {
        const error = new TypeError(message);
        expect(isNetworkError(error)).to.be.false;
      });
    });
  });

  describe("edge cases", () => {
    it("should return false for empty TypeError", () => {
      const error = new TypeError("");
      expect(isNetworkError(error)).to.be.false;
    });

    it("should return false for TypeError with partial match", () => {
      const error = new TypeError("network");
      expect(isNetworkError(error)).to.be.false;
    });

    it("should be case-sensitive for error messages", () => {
      const error = new TypeError("Network Error"); // Different case
      expect(isNetworkError(error)).to.be.false;
    });

    it("should return false for error without response property", () => {
      const error = { name: "TypeError", message: "custom error" };
      expect(isNetworkError(error)).to.be.false;
    });
  });
});
