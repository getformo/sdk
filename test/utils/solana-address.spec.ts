import { describe, it } from "mocha";
import { expect } from "chai";
import {
  isValidSolanaAddress,
  getValidSolanaAddress,
  isBlockedSolanaAddress,
  detectAddressType,
  shortenSolanaAddress,
} from "../../src/utils/solana-address";

describe("Solana Address Utilities", () => {
  // Example valid Solana addresses
  const SYSTEM_PROGRAM = "11111111111111111111111111111111";
  const WRAPPED_SOL = "So11111111111111111111111111111112";
  const EXAMPLE_WALLET = "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV";
  const PHANTOM_WALLET = "8ZpKPoPxMU3BbvGUTt3qR4xR4wqkPLJWphpQnqJ8NLRW";

  describe("isValidSolanaAddress", () => {
    it("should return true for valid Solana addresses", () => {
      expect(isValidSolanaAddress(SYSTEM_PROGRAM)).to.be.true;
      expect(isValidSolanaAddress(WRAPPED_SOL)).to.be.true;
      expect(isValidSolanaAddress(EXAMPLE_WALLET)).to.be.true;
      expect(isValidSolanaAddress(PHANTOM_WALLET)).to.be.true;
    });

    it("should return false for EVM addresses", () => {
      expect(
        isValidSolanaAddress("0x82827Bc8342a16b681AfbA6B979E3D1aE5F28a0e")
      ).to.be.false;
      expect(
        isValidSolanaAddress("0x7E6CA77a7E044BA836a97beB796c124Ca3a6A255")
      ).to.be.false;
    });

    it("should return false for addresses that are too short", () => {
      expect(isValidSolanaAddress("abc")).to.be.false;
      expect(isValidSolanaAddress("1234567890")).to.be.false;
      expect(isValidSolanaAddress("123456789012345678901234567890")).to.be
        .false; // 30 chars, min is 32
    });

    it("should return false for addresses that are too long", () => {
      expect(
        isValidSolanaAddress(
          "1234567890123456789012345678901234567890123456789"
        )
      ).to.be.false; // 49 chars, max is 44
    });

    it("should return false for addresses with invalid base58 characters", () => {
      // 0, O, I, l are not in base58 alphabet
      expect(isValidSolanaAddress("0111111111111111111111111111111")).to.be
        .false;
      expect(isValidSolanaAddress("O1111111111111111111111111111111")).to.be
        .false;
      expect(isValidSolanaAddress("I1111111111111111111111111111111")).to.be
        .false;
      expect(isValidSolanaAddress("l1111111111111111111111111111111")).to.be
        .false;
    });

    it("should return false for null, undefined, or empty values", () => {
      expect(isValidSolanaAddress(null)).to.be.false;
      expect(isValidSolanaAddress(undefined)).to.be.false;
      expect(isValidSolanaAddress("")).to.be.false;
      expect(isValidSolanaAddress("   ")).to.be.false;
    });

    it("should handle addresses with whitespace by trimming", () => {
      expect(isValidSolanaAddress(`  ${SYSTEM_PROGRAM}  `)).to.be.true;
      expect(isValidSolanaAddress(`\t${WRAPPED_SOL}\n`)).to.be.true;
    });
  });

  describe("getValidSolanaAddress", () => {
    it("should return trimmed address for valid addresses", () => {
      expect(getValidSolanaAddress(SYSTEM_PROGRAM)).to.equal(SYSTEM_PROGRAM);
      expect(getValidSolanaAddress(`  ${WRAPPED_SOL}  `)).to.equal(WRAPPED_SOL);
    });

    it("should return null for invalid addresses", () => {
      expect(getValidSolanaAddress("invalid")).to.be.null;
      expect(
        getValidSolanaAddress("0x82827Bc8342a16b681AfbA6B979E3D1aE5F28a0e")
      ).to.be.null;
      expect(getValidSolanaAddress(null)).to.be.null;
      expect(getValidSolanaAddress(undefined)).to.be.null;
    });
  });

  describe("isBlockedSolanaAddress", () => {
    it("should return true for System Program address", () => {
      expect(isBlockedSolanaAddress(SYSTEM_PROGRAM)).to.be.true;
    });

    it("should return false for normal wallet addresses", () => {
      expect(isBlockedSolanaAddress(WRAPPED_SOL)).to.be.false;
      expect(isBlockedSolanaAddress(EXAMPLE_WALLET)).to.be.false;
      expect(isBlockedSolanaAddress(PHANTOM_WALLET)).to.be.false;
    });

    it("should return false for null, undefined, or empty addresses", () => {
      expect(isBlockedSolanaAddress(null)).to.be.false;
      expect(isBlockedSolanaAddress(undefined)).to.be.false;
      expect(isBlockedSolanaAddress("")).to.be.false;
    });

    it("should return false for invalid addresses", () => {
      expect(isBlockedSolanaAddress("invalid")).to.be.false;
      expect(
        isBlockedSolanaAddress("0x0000000000000000000000000000000000000000")
      ).to.be.false;
    });
  });

  describe("detectAddressType", () => {
    it("should detect Solana addresses", () => {
      expect(detectAddressType(SYSTEM_PROGRAM)).to.equal("solana");
      expect(detectAddressType(WRAPPED_SOL)).to.equal("solana");
      expect(detectAddressType(EXAMPLE_WALLET)).to.equal("solana");
    });

    it("should detect EVM addresses", () => {
      expect(
        detectAddressType("0x82827Bc8342a16b681AfbA6B979E3D1aE5F28a0e")
      ).to.equal("evm");
      expect(
        detectAddressType("0x7E6CA77a7E044BA836a97beB796c124Ca3a6A255")
      ).to.equal("evm");
      expect(
        detectAddressType("0x0000000000000000000000000000000000000000")
      ).to.equal("evm");
    });

    it("should return null for invalid addresses", () => {
      expect(detectAddressType("invalid")).to.be.null;
      expect(detectAddressType("0x123")).to.be.null;
      expect(detectAddressType(null)).to.be.null;
      expect(detectAddressType(undefined)).to.be.null;
    });

    it("should handle addresses with whitespace", () => {
      expect(detectAddressType(`  ${SYSTEM_PROGRAM}  `)).to.equal("solana");
      expect(
        detectAddressType("  0x82827Bc8342a16b681AfbA6B979E3D1aE5F28a0e  ")
      ).to.equal("evm");
    });
  });

  describe("shortenSolanaAddress", () => {
    it("should shorten addresses with default parameters", () => {
      expect(shortenSolanaAddress(SYSTEM_PROGRAM)).to.equal("1111...1111");
      expect(shortenSolanaAddress(WRAPPED_SOL)).to.equal("So11...1112");
    });

    it("should shorten addresses with custom parameters", () => {
      expect(shortenSolanaAddress(SYSTEM_PROGRAM, 6, 6)).to.equal(
        "111111...111111"
      );
      expect(shortenSolanaAddress(WRAPPED_SOL, 2, 2)).to.equal("So...12");
    });

    it("should return original address if too short to shorten", () => {
      // If startChars + endChars + 3 >= length, return original
      expect(shortenSolanaAddress(SYSTEM_PROGRAM, 15, 15)).to.equal(
        SYSTEM_PROGRAM
      );
    });

    it("should return empty string for invalid addresses", () => {
      expect(shortenSolanaAddress(null)).to.equal("");
      expect(shortenSolanaAddress(undefined)).to.equal("");
      expect(shortenSolanaAddress("invalid")).to.equal("invalid");
    });
  });
});
