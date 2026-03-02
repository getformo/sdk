import { describe, it } from "mocha";
import { expect } from "chai";
import { extractBuilderCodes } from "../../src/utils/builderCode";

/**
 * Helper to build an ERC-8021 data suffix for Schema 0.
 *
 * Format (appended to calldata):
 *   [codes (ASCII)] [codesLength (1 byte)] [schemaId 0x00 (1 byte)] [ercMarker (16 bytes)]
 *
 * @param codes - Array of builder code strings
 * @returns Hex string of the suffix (without 0x prefix)
 */
function buildErc8021Suffix(codes: string[]): string {
  // Join codes with comma (0x2C) and convert to hex
  const codesStr = codes.join(",");
  const codesHex = Array.from(codesStr)
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("");
  const codesLength = (codesHex.length / 2)
    .toString(16)
    .padStart(2, "0");
  const schemaId = "00";
  const ercMarker = "80218021802180218021802180218021";
  return codesHex + codesLength + schemaId + ercMarker;
}

describe("extractBuilderCodes", () => {
  describe("valid ERC-8021 suffixes", () => {
    it("should extract a single builder code", () => {
      const suffix = buildErc8021Suffix(["myapp"]);
      const data = "0xabcdef" + suffix;

      const result = extractBuilderCodes(data);
      expect(result).to.deep.equal(["myapp"]);
    });

    it("should extract multiple comma-separated builder codes", () => {
      const suffix = buildErc8021Suffix(["app1", "app2", "wallet1"]);
      const data = "0xabcdef" + suffix;

      const result = extractBuilderCodes(data);
      expect(result).to.deep.equal(["app1", "app2", "wallet1"]);
    });

    it("should work with just the suffix (no original calldata)", () => {
      const suffix = buildErc8021Suffix(["builder"]);
      const data = "0x" + suffix;

      const result = extractBuilderCodes(data);
      expect(result).to.deep.equal(["builder"]);
    });

    it("should work without 0x prefix", () => {
      const suffix = buildErc8021Suffix(["abc123"]);
      const data = "deadbeef" + suffix;

      const result = extractBuilderCodes(data);
      expect(result).to.deep.equal(["abc123"]);
    });

    it("should handle uppercase hex input", () => {
      const suffix = buildErc8021Suffix(["mycode"]);
      const data = "0xABCDEF" + suffix.toUpperCase();

      const result = extractBuilderCodes(data);
      expect(result).to.deep.equal(["mycode"]);
    });

    it("should handle codes with alphanumeric characters", () => {
      const suffix = buildErc8021Suffix(["base-app-v2"]);
      const data = "0x1234" + suffix;

      const result = extractBuilderCodes(data);
      expect(result).to.deep.equal(["base-app-v2"]);
    });

    it("should handle a real-world example with function calldata", () => {
      // Simulate a transfer function call + ERC-8021 suffix
      const transferCalldata =
        "a9059cbb" + // transfer(address,uint256) selector
        "0000000000000000000000001234567890abcdef1234567890abcdef12345678" +
        "0000000000000000000000000000000000000000000000000de0b6b3a7640000";
      const suffix = buildErc8021Suffix(["morpho"]);
      const data = "0x" + transferCalldata + suffix;

      const result = extractBuilderCodes(data);
      expect(result).to.deep.equal(["morpho"]);
    });
  });

  describe("invalid or absent suffixes", () => {
    it("should return undefined for null input", () => {
      expect(extractBuilderCodes(null)).to.be.undefined;
    });

    it("should return undefined for undefined input", () => {
      expect(extractBuilderCodes(undefined)).to.be.undefined;
    });

    it("should return undefined for empty string", () => {
      expect(extractBuilderCodes("")).to.be.undefined;
    });

    it("should return undefined for non-string input", () => {
      expect(extractBuilderCodes(123 as any)).to.be.undefined;
    });

    it("should return undefined for calldata without ERC-8021 marker", () => {
      const data =
        "0xa9059cbb" +
        "0000000000000000000000001234567890abcdef1234567890abcdef12345678" +
        "0000000000000000000000000000000000000000000000000de0b6b3a7640000";

      expect(extractBuilderCodes(data)).to.be.undefined;
    });

    it("should return undefined for data that is too short", () => {
      expect(extractBuilderCodes("0x1234")).to.be.undefined;
    });

    it("should return undefined for data with partial ERC marker", () => {
      expect(
        extractBuilderCodes("0xabcdef8021802180218021802180218021")
      ).to.be.undefined;
    });
  });

  describe("edge cases", () => {
    it("should return undefined if codesLength is 0", () => {
      // Manually build a suffix with codesLength = 0
      const schemaId = "00";
      const ercMarker = "80218021802180218021802180218021";
      const data = "0xabcdef" + "00" + schemaId + ercMarker;

      expect(extractBuilderCodes(data)).to.be.undefined;
    });

    it("should return undefined if codesLength exceeds available data", () => {
      // Build suffix claiming 255 bytes of codes but only has a few
      const schemaId = "00";
      const ercMarker = "80218021802180218021802180218021";
      const data = "0x" + "aabb" + "ff" + schemaId + ercMarker;

      expect(extractBuilderCodes(data)).to.be.undefined;
    });

    it("should handle single character builder code", () => {
      const suffix = buildErc8021Suffix(["x"]);
      const data = "0xab" + suffix;

      const result = extractBuilderCodes(data);
      expect(result).to.deep.equal(["x"]);
    });

    it("should return undefined for unsupported schema IDs", () => {
      // Build a suffix with schemaId = 0x01 instead of 0x00
      const codesStr = "myapp";
      const codesHex = Array.from(codesStr)
        .map((c) => c.charCodeAt(0).toString(16).padStart(2, "0"))
        .join("");
      const codesLength = (codesHex.length / 2)
        .toString(16)
        .padStart(2, "0");
      const schemaId = "01"; // Unsupported schema
      const ercMarker = "80218021802180218021802180218021";
      const data = "0xabcdef" + codesHex + codesLength + schemaId + ercMarker;

      expect(extractBuilderCodes(data)).to.be.undefined;
    });
  });
});
