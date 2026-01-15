import { describe, it } from "mocha";
import { expect } from "chai";
import { JSON_PREFIX, KEY_PREFIX } from "../../src/storage/constant";

/**
 * Tests to ensure storage prefix values remain stable for backward compatibility.
 *
 * IMPORTANT: These prefixes are used when storing data in cookies/localStorage.
 * If these values change, existing users will:
 * - Lose all stored analytics data
 * - Appear as new visitors
 * - Have accumulated storage from old prefix as orphaned data
 *
 * If you need to change these values, you MUST implement a migration strategy.
 */
describe("Storage Constants - Backward Compatibility", () => {
  describe("Storage prefix values must not change", () => {
    it("JSON_PREFIX should have stable value", () => {
      expect(JSON_PREFIX).to.equal("__json=");
    });

    it("KEY_PREFIX should have stable value", () => {
      expect(KEY_PREFIX).to.equal("formo");
    });
  });
});
