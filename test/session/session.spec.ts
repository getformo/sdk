import { describe, it } from "mocha";
import { expect } from "chai";
import {
  SESSION_WALLET_DETECTED_KEY,
  SESSION_WALLET_IDENTIFIED_KEY,
} from "../../src/session";

/**
 * Tests to ensure session cookie key values remain stable for backward compatibility.
 *
 * IMPORTANT: These keys are stored in user browsers as cookies. If these values change,
 * existing users will have their session state reset, causing:
 * - Duplicate wallet detection events
 * - Duplicate wallet identification events
 * - Poor analytics data quality
 *
 * If you need to change these values, you MUST implement a migration strategy.
 */
describe("Session Constants - Backward Compatibility", () => {
  describe("Cookie key values must not change", () => {
    it("SESSION_WALLET_DETECTED_KEY should have stable value", () => {
      // This value is stored in user browsers - DO NOT CHANGE without migration
      expect(SESSION_WALLET_DETECTED_KEY).to.equal("wallet-detected");
    });

    it("SESSION_WALLET_IDENTIFIED_KEY should have stable value", () => {
      // This value is stored in user browsers - DO NOT CHANGE without migration
      expect(SESSION_WALLET_IDENTIFIED_KEY).to.equal("wallet-identified");
    });
  });
});
