import { describe, it } from "mocha";
import { expect } from "chai";
import {
  SESSION_TRAFFIC_SOURCE_KEY,
  SESSION_CURRENT_URL_KEY,
  SESSION_USER_ID_KEY,
  LOCAL_ANONYMOUS_ID_KEY,
  CONSENT_OPT_OUT_KEY,
} from "../../src/constants/base";

/**
 * Tests to ensure storage key values remain stable for backward compatibility.
 *
 * IMPORTANT: These keys are stored in user browsers as cookies/localStorage.
 * If these values change, existing users will lose their stored data, causing:
 * - Loss of anonymous ID (new user appears as new visitor)
 * - Loss of user ID association
 * - Loss of traffic source attribution
 * - Loss of consent preferences
 *
 * If you need to change these values, you MUST implement a migration strategy.
 */
describe("Constants - Backward Compatibility", () => {
  describe("Storage key values must not change", () => {
    it("SESSION_TRAFFIC_SOURCE_KEY should have stable value", () => {
      expect(SESSION_TRAFFIC_SOURCE_KEY).to.equal("traffic-source");
    });

    it("SESSION_CURRENT_URL_KEY should have stable value", () => {
      expect(SESSION_CURRENT_URL_KEY).to.equal("analytics-current-url");
    });

    it("SESSION_USER_ID_KEY should have stable value", () => {
      expect(SESSION_USER_ID_KEY).to.equal("user-id");
    });

    it("LOCAL_ANONYMOUS_ID_KEY should have stable value", () => {
      expect(LOCAL_ANONYMOUS_ID_KEY).to.equal("anonymous-id");
    });

    it("CONSENT_OPT_OUT_KEY should have stable value", () => {
      expect(CONSENT_OPT_OUT_KEY).to.equal("opt-out-tracking");
    });
  });
});
