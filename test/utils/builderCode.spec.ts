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
  describe("Schema 0 - canonical registry", () => {
    it("should decode 'baseapp' from exact hex vector", () => {
      // txData || "baseapp" || 7 || 0 || ercMarker
      const data =
        "0xdddddddd62617365617070070080218021802180218021802180218021";

      const result = extractBuilderCodes(data);
      expect(result).to.deep.equal({ builder_codes: "baseapp" });
    });

    it("should extract a single builder code", () => {
      const suffix = buildErc8021Suffix(["myapp"]);
      const data = "0xabcdef" + suffix;

      const result = extractBuilderCodes(data);
      expect(result).to.deep.equal({ builder_codes: "myapp" });
    });

    it("should extract multiple codes as comma-separated string", () => {
      const suffix = buildErc8021Suffix(["app1", "app2", "wallet1"]);
      const data = "0xabcdef" + suffix;

      const result = extractBuilderCodes(data);
      expect(result).to.deep.equal({ builder_codes: "app1,app2,wallet1" });
    });

    it("should work with just the suffix (no original calldata)", () => {
      const suffix = buildErc8021Suffix(["builder"]);
      const data = "0x" + suffix;

      const result = extractBuilderCodes(data);
      expect(result).to.deep.equal({ builder_codes: "builder" });
    });

    it("should work without 0x prefix", () => {
      const suffix = buildErc8021Suffix(["abc123"]);
      const data = "deadbeef" + suffix;

      const result = extractBuilderCodes(data);
      expect(result).to.deep.equal({ builder_codes: "abc123" });
    });

    it("should handle uppercase hex input", () => {
      const suffix = buildErc8021Suffix(["mycode"]);
      const data = "0xABCDEF" + suffix.toUpperCase();

      const result = extractBuilderCodes(data);
      expect(result).to.deep.equal({ builder_codes: "mycode" });
    });

    it("should handle codes with alphanumeric characters", () => {
      const suffix = buildErc8021Suffix(["base-app-v2"]);
      const data = "0x1234" + suffix;

      const result = extractBuilderCodes(data);
      expect(result).to.deep.equal({ builder_codes: "base-app-v2" });
    });

    it("should extract two codes as comma-separated string", () => {
      const suffix = buildErc8021Suffix(["uniswap", "base"]);
      const data = "0xabcdef" + suffix;

      const result = extractBuilderCodes(data);
      expect(result).to.deep.equal({ builder_codes: "uniswap,base" });
    });

    it("should handle a real-world transfer call with builder code suffix", () => {
      // transfer(address,uint256) selector + args + ERC-8021 suffix
      const transferCalldata =
        "a9059cbb" +
        "0000000000000000000000001234567890abcdef1234567890abcdef12345678" +
        "0000000000000000000000000000000000000000000000000de0b6b3a7640000";
      const suffix = buildErc8021Suffix(["morpho"]);
      const data = "0x" + transferCalldata + suffix;

      const result = extractBuilderCodes(data);
      expect(result).to.deep.equal({ builder_codes: "morpho" });
    });

    it("should not include registry fields for Schema 0", () => {
      const suffix = buildErc8021Suffix(["myapp"]);
      const data = "0xabcdef" + suffix;

      const result = extractBuilderCodes(data);
      expect(result).to.not.have.property("builder_codes_registry_chain_id");
      expect(result).to.not.have.property("builder_codes_registry_address");
    });
  });

  describe("Schema 1 - custom registry", () => {
    it("should decode 'baseapp,morpho' with registry fields from exact hex vector", () => {
      // txData || registryAddress (20 bytes) || chainId (8453=0x2105) || chainIdLength (2) ||
      // "baseapp,morpho" || codesLength (14=0x0E) || schemaId (1) || ercMarker
      const data =
        "0xdddddddd" +
        "cccccccccccccccccccccccccccccccccccccccc" +
        "2105" +
        "02" +
        "626173656170702c6d6f7270686f" +
        "0e" +
        "01" +
        "80218021802180218021802180218021";

      const result = extractBuilderCodes(data);
      expect(result).to.deep.equal({
        builder_codes: "baseapp,morpho",
        builder_codes_registry_chain_id: "8453",
        builder_codes_registry_address: "0xcccccccccccccccccccccccccccccccccccccccc",
      });
    });

    it("should extract a single code with custom registry", () => {
      // registryAddress (20 bytes) + chainId (1 byte, chainId=1) + chainIdLength (1) +
      // "myapp" + codesLength (5) + schemaId (1) + ercMarker
      const registryAddress = "aabbccddee11223344556677889900aabbccddee";
      const chainId = "01"; // chainId = 1
      const chainIdLength = "01";
      const codesHex = "6d79617070"; // "myapp"
      const codesLength = "05";
      const schemaId = "01";
      const ercMarker = "80218021802180218021802180218021";
      const data =
        "0xabcdef" +
        registryAddress +
        chainId +
        chainIdLength +
        codesHex +
        codesLength +
        schemaId +
        ercMarker;

      const result = extractBuilderCodes(data);
      expect(result).to.deep.equal({
        builder_codes: "myapp",
        builder_codes_registry_chain_id: "1",
        builder_codes_registry_address: "0x" + registryAddress,
      });
    });

    it("should extract three codes with custom registry on Base", () => {
      const registryAddress = "1111111111111111111111111111111111111111";
      const chainId = "2105"; // Base mainnet = 8453
      const chainIdLength = "02";
      const codesStr = "app1,app2,app3";
      const codesHex = Array.from(codesStr)
        .map((c) => c.charCodeAt(0).toString(16).padStart(2, "0"))
        .join("");
      const codesLength = (codesHex.length / 2)
        .toString(16)
        .padStart(2, "0");
      const schemaId = "01";
      const ercMarker = "80218021802180218021802180218021";
      const data =
        "0xdeadbeef" +
        registryAddress +
        chainId +
        chainIdLength +
        codesHex +
        codesLength +
        schemaId +
        ercMarker;

      const result = extractBuilderCodes(data);
      expect(result).to.deep.equal({
        builder_codes: "app1,app2,app3",
        builder_codes_registry_chain_id: "8453",
        builder_codes_registry_address: "0x" + registryAddress,
      });
    });

    it("should return codes without registry fields when registry data is insufficient", () => {
      // Schema 1 with codes but not enough preceding data for registry fields
      const codesHex = "6d79617070"; // "myapp"
      const codesLength = "05";
      const schemaId = "01";
      const ercMarker = "80218021802180218021802180218021";
      // No room for registryAddress + chainId before codes
      const data = "0x" + codesHex + codesLength + schemaId + ercMarker;

      const result = extractBuilderCodes(data);
      expect(result).to.deep.equal({ builder_codes: "myapp" });
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

    it("should return undefined for unknown schemaId (0xFF)", () => {
      // txData || unknown schemaId || ercMarker
      const data =
        "0xddddddddff80218021802180218021802180218021";

      expect(extractBuilderCodes(data)).to.be.undefined;
    });

    it("should return undefined for unknown schemaId (0x02)", () => {
      const codesHex = "6d79617070"; // "myapp"
      const codesLength = "05";
      const schemaId = "02";
      const ercMarker = "80218021802180218021802180218021";
      const data = "0xabcdef" + codesHex + codesLength + schemaId + ercMarker;

      expect(extractBuilderCodes(data)).to.be.undefined;
    });
  });

  describe("edge cases", () => {
    it("should return undefined if codesLength is 0", () => {
      const schemaId = "00";
      const ercMarker = "80218021802180218021802180218021";
      const data = "0xabcdef" + "00" + schemaId + ercMarker;

      expect(extractBuilderCodes(data)).to.be.undefined;
    });

    it("should return undefined if codesLength exceeds available data", () => {
      const schemaId = "00";
      const ercMarker = "80218021802180218021802180218021";
      const data = "0x" + "aabb" + "ff" + schemaId + ercMarker;

      expect(extractBuilderCodes(data)).to.be.undefined;
    });

    it("should handle single character builder code", () => {
      const suffix = buildErc8021Suffix(["x"]);
      const data = "0xab" + suffix;

      const result = extractBuilderCodes(data);
      expect(result).to.deep.equal({ builder_codes: "x" });
    });

    it("should return undefined if codes contain non-printable bytes", () => {
      const codesHex = "6d79" + "01" + "617070"; // "my" + 0x01 + "app"
      const codesLength = (codesHex.length / 2)
        .toString(16)
        .padStart(2, "0");
      const schemaId = "00";
      const ercMarker = "80218021802180218021802180218021";
      const data = "0xabcdef" + codesHex + codesLength + schemaId + ercMarker;

      expect(extractBuilderCodes(data)).to.be.undefined;
    });

    it("should return undefined if codes contain extended ASCII bytes", () => {
      const codesHex = "6d79" + "ff" + "617070"; // "my" + 0xFF + "app"
      const codesLength = (codesHex.length / 2)
        .toString(16)
        .padStart(2, "0");
      const schemaId = "00";
      const ercMarker = "80218021802180218021802180218021";
      const data = "0xabcdef" + codesHex + codesLength + schemaId + ercMarker;

      expect(extractBuilderCodes(data)).to.be.undefined;
    });

    it("should return undefined for unsupported schema IDs", () => {
      const codesStr = "myapp";
      const codesHex = Array.from(codesStr)
        .map((c) => c.charCodeAt(0).toString(16).padStart(2, "0"))
        .join("");
      const codesLength = (codesHex.length / 2)
        .toString(16)
        .padStart(2, "0");
      const schemaId = "03"; // Unsupported schema
      const ercMarker = "80218021802180218021802180218021";
      const data = "0xabcdef" + codesHex + codesLength + schemaId + ercMarker;

      expect(extractBuilderCodes(data)).to.be.undefined;
    });
  });
});
