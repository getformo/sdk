import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import {
  toSnakeCase,
  millisecondsToSecond,
  toDateHourMinute,
  toDateHourMinuteSecond,
  clampNumber,
} from "../../src/utils/converter";
import { getActionDescriptor } from "../../src/utils/base";
import { secureHash } from "../../src/utils/hash";

describe("Utility Functions", () => {
  describe("toSnakeCase", () => {
    it("should convert camelCase to snake_case", () => {
      expect(toSnakeCase({ firstName: "John" })).to.deep.equal({
        first_name: "John",
      });
    });

    it("should convert PascalCase to snake_case", () => {
      expect(toSnakeCase({ FirstName: "John" })).to.deep.equal({
        first_name: "John",
      });
    });

    it("should handle nested objects", () => {
      expect(
        toSnakeCase({
          userData: {
            firstName: "John",
            lastName: "Doe",
          },
        })
      ).to.deep.equal({
        user_data: {
          first_name: "John",
          last_name: "Doe",
        },
      });
    });

    it("should handle arrays", () => {
      expect(
        toSnakeCase({
          userList: [{ firstName: "John" }, { firstName: "Jane" }],
        })
      ).to.deep.equal({
        user_list: [{ first_name: "John" }, { first_name: "Jane" }],
      });
    });

    it("should respect omitKeys", () => {
      expect(
        toSnakeCase(
          {
            firstName: "John",
            "user-agent": "Mozilla",
            lastName: "Doe",
          },
          ["user-agent"]
        )
      ).to.deep.equal({
        first_name: "John",
        "user-agent": "Mozilla",
        last_name: "Doe",
      });
    });

    it("should handle primitive values", () => {
      expect(toSnakeCase("string")).to.equal("string");
      expect(toSnakeCase(123)).to.equal(123);
      expect(toSnakeCase(null)).to.be.null;
    });

    it("should handle multiple consecutive capitals", () => {
      // The implementation doesn't break up consecutive capitals individually
      expect(toSnakeCase({ XMLParser: "test" })).to.deep.equal({
        xmlparser: "test",
      });
    });

    it("should handle hyphenated keys", () => {
      expect(toSnakeCase({ "kebab-case": "value" })).to.deep.equal({
        kebab_case: "value",
      });
    });

    it("should handle keys with spaces", () => {
      expect(toSnakeCase({ "key with spaces": "value" })).to.deep.equal({
        key_with_spaces: "value",
      });
    });
  });

  describe("millisecondsToSecond", () => {
    it("should convert milliseconds to seconds (rounded up)", () => {
      expect(millisecondsToSecond(1000)).to.equal(1);
      expect(millisecondsToSecond(1500)).to.equal(2);
      expect(millisecondsToSecond(500)).to.equal(1);
      expect(millisecondsToSecond(0)).to.equal(0);
    });

    it("should handle large values", () => {
      expect(millisecondsToSecond(60000)).to.equal(60);
      expect(millisecondsToSecond(3600000)).to.equal(3600);
    });

    it("should ceil fractional seconds", () => {
      expect(millisecondsToSecond(1001)).to.equal(2);
      expect(millisecondsToSecond(999)).to.equal(1);
    });
  });

  describe("toDateHourMinute", () => {
    it("should format date to YYYY-MM-DD HH:mm", () => {
      const date = new Date(Date.UTC(2024, 0, 15, 10, 30, 45));
      expect(toDateHourMinute(date)).to.equal("2024-01-15 10:30");
    });

    it("should pad single digit months and days", () => {
      const date = new Date(Date.UTC(2024, 0, 5, 5, 5, 0));
      expect(toDateHourMinute(date)).to.equal("2024-01-05 05:05");
    });

    it("should handle midnight", () => {
      const date = new Date(Date.UTC(2024, 5, 15, 0, 0, 0));
      expect(toDateHourMinute(date)).to.equal("2024-06-15 00:00");
    });

    it("should handle end of day", () => {
      const date = new Date(Date.UTC(2024, 11, 31, 23, 59, 59));
      expect(toDateHourMinute(date)).to.equal("2024-12-31 23:59");
    });
  });

  describe("toDateHourMinuteSecond", () => {
    it("should format date to YYYY-MM-DD HH:mm:ss", () => {
      const date = new Date(Date.UTC(2024, 0, 15, 10, 30, 45));
      expect(toDateHourMinuteSecond(date)).to.equal("2024-01-15 10:30:45");
    });

    it("should pad single digit months, days, and seconds", () => {
      const date = new Date(Date.UTC(2024, 0, 5, 5, 5, 3));
      expect(toDateHourMinuteSecond(date)).to.equal("2024-01-05 05:05:03");
    });

    it("should handle midnight", () => {
      const date = new Date(Date.UTC(2024, 5, 15, 0, 0, 0));
      expect(toDateHourMinuteSecond(date)).to.equal("2024-06-15 00:00:00");
    });

    it("should handle end of day", () => {
      const date = new Date(Date.UTC(2024, 11, 31, 23, 59, 59));
      expect(toDateHourMinuteSecond(date)).to.equal("2024-12-31 23:59:59");
    });

    it("should differentiate events in the same minute but different seconds", () => {
      const date1 = new Date(Date.UTC(2024, 0, 15, 10, 30, 15));
      const date2 = new Date(Date.UTC(2024, 0, 15, 10, 30, 45));
      expect(toDateHourMinuteSecond(date1)).to.not.equal(toDateHourMinuteSecond(date2));
    });
  });

  describe("clampNumber", () => {
    it("should return value when within range", () => {
      expect(clampNumber(5, 10, 1)).to.equal(5);
      expect(clampNumber(7, 10, 1)).to.equal(7);
    });

    it("should return min when value is below range", () => {
      expect(clampNumber(0, 10, 1)).to.equal(1);
      expect(clampNumber(-5, 10, 1)).to.equal(1);
    });

    it("should return max when value is above range", () => {
      expect(clampNumber(15, 10, 1)).to.equal(10);
      expect(clampNumber(100, 10, 1)).to.equal(10);
    });

    it("should handle edge cases at boundaries", () => {
      expect(clampNumber(1, 10, 1)).to.equal(1);
      expect(clampNumber(10, 10, 1)).to.equal(10);
    });

    it("should handle negative ranges", () => {
      expect(clampNumber(-5, -1, -10)).to.equal(-5);
      expect(clampNumber(-15, -1, -10)).to.equal(-10);
      expect(clampNumber(0, -1, -10)).to.equal(-1);
    });

    it("should handle zero in range", () => {
      expect(clampNumber(0, 5, -5)).to.equal(0);
    });
  });

  describe("getActionDescriptor", () => {
    it("should return type for basic events", () => {
      expect(getActionDescriptor("page", {})).to.equal("page");
      expect(getActionDescriptor("track", {})).to.equal("track");
    });

    it("should include status when present", () => {
      expect(getActionDescriptor("signature", { status: "success" })).to.equal(
        "signature success"
      );
      expect(getActionDescriptor("transaction", { status: "pending" })).to.equal(
        "transaction pending"
      );
    });

    it("should include rdns for connect events", () => {
      expect(
        getActionDescriptor("connect", { rdns: "io.metamask" })
      ).to.equal("connect (io.metamask)");
    });

    it("should include rdns for disconnect events", () => {
      expect(
        getActionDescriptor("disconnect", { rdns: "com.coinbase.wallet" })
      ).to.equal("disconnect (com.coinbase.wallet)");
    });

    it("should not include rdns for other event types", () => {
      expect(getActionDescriptor("page", { rdns: "io.metamask" })).to.equal(
        "page"
      );
    });

    it("should handle both status and rdns", () => {
      expect(
        getActionDescriptor("connect", { status: "success", rdns: "io.metamask" })
      ).to.equal("connect success (io.metamask)");
    });

    it("should handle null properties", () => {
      expect(getActionDescriptor("page", null as any)).to.equal("page");
    });

    it("should handle undefined properties", () => {
      expect(getActionDescriptor("page", undefined as any)).to.equal("page");
    });
  });

  describe("secureHash", () => {
    it("should return a consistent hash for the same input", () => {
      const hash1 = secureHash("test-input");
      const hash2 = secureHash("test-input");
      expect(hash1).to.equal(hash2);
    });

    it("should return different hashes for different inputs", () => {
      const hash1 = secureHash("input1");
      const hash2 = secureHash("input2");
      expect(hash1).to.not.equal(hash2);
    });

    it("should return 8-character hex string", () => {
      const hash = secureHash("test");
      expect(hash).to.have.lengthOf(8);
      expect(hash).to.match(/^[0-9a-f]{8}$/);
    });

    it("should handle empty string", () => {
      const hash = secureHash("");
      expect(hash).to.have.lengthOf(8);
    });

    it("should handle special characters", () => {
      const hash = secureHash("test@#$%^&*()");
      expect(hash).to.have.lengthOf(8);
    });

    it("should handle unicode characters", () => {
      const hash = secureHash("test 🎉 emoji");
      expect(hash).to.have.lengthOf(8);
    });

    it("should handle long strings", () => {
      const longString = "a".repeat(10000);
      const hash = secureHash(longString);
      expect(hash).to.have.lengthOf(8);
    });
  });
});

describe("Hash and Generate Utilities", () => {
  describe("hash (async)", () => {
    let originalCrypto: any;

    beforeEach(() => {
      originalCrypto = (global as any).crypto;
      (global as any).crypto = {
        subtle: {
          digest: async (_algorithm: string, data: ArrayBuffer) => {
            // Simple mock that returns predictable output
            const input = new TextDecoder().decode(data);
            const mockHash = new Uint8Array(32);
            for (let i = 0; i < 32; i++) {
              mockHash[i] = (input.charCodeAt(i % input.length) || 0) % 256;
            }
            return mockHash.buffer;
          },
        },
        randomUUID: () => "12345678-1234-1234-1234-123456789abc",
      };
    });

    afterEach(() => {
      (global as any).crypto = originalCrypto;
    });

    it("should return a 64-character hex string", async () => {
      const { hash } = await import("../../src/utils/generate");
      const result = await hash("test");
      expect(result).to.have.lengthOf(64);
      expect(result).to.match(/^[0-9a-f]{64}$/);
    });

    it("should return consistent results for same input", async () => {
      const { hash } = await import("../../src/utils/generate");
      const hash1 = await hash("test");
      const hash2 = await hash("test");
      expect(hash1).to.equal(hash2);
    });
  });

  describe("generateNativeUUID", () => {
    let originalCrypto: any;

    beforeEach(() => {
      originalCrypto = (global as any).crypto;
      (global as any).crypto = {
        randomUUID: () => "12345678-1234-1234-1234-123456789abc",
      };
    });

    afterEach(() => {
      (global as any).crypto = originalCrypto;
    });

    it("should return a UUID string", () => {
      const { generateNativeUUID } = require("../../src/utils/generate");
      const uuid = generateNativeUUID();
      expect(uuid).to.equal("12345678-1234-1234-1234-123456789abc");
    });

    it("should return valid UUID format", () => {
      const { generateNativeUUID } = require("../../src/utils/generate");
      const uuid = generateNativeUUID();
      expect(uuid).to.match(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
    });
  });
});
