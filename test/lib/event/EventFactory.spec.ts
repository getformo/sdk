import { describe, it } from "mocha";
import { expect } from "chai";
import { toChecksumAddress, isValidAddress, getValidAddress } from "../../../src/utils";
import { isAddress } from "../../../src/validators";

describe("Address handling bug fix", () => {
  describe("toChecksumAddress function", () => {
    it("should throw error when empty string is passed", () => {
      expect(() => toChecksumAddress("")).to.throw("Invalid address ");
    });

    it("should throw error when undefined is passed", () => {
      expect(() => toChecksumAddress(undefined as any)).to.throw("Invalid address undefined");
    });

    it("should throw error when null is passed", () => {
      expect(() => toChecksumAddress(null as any)).to.throw("Invalid address null");
    });

    it("should handle valid addresses correctly", () => {
      const validAddress = "0x1095bBe769fDab716A823d0f7149CAD713d20A13";
      expect(() => toChecksumAddress(validAddress)).to.not.throw();
    });
  });

  describe("isValidAddress helper function", () => {
    it("should correctly identify empty strings as invalid", () => {
      const testAddress: string = "";
      expect(isValidAddress(testAddress)).to.be.false;
    });

    it("should correctly identify undefined as invalid", () => {
      const testAddress: string | undefined = undefined;
      expect(isValidAddress(testAddress)).to.be.false;
    });

    it("should correctly identify null as invalid", () => {
      const testAddress: string | null = null;
      expect(isValidAddress(testAddress)).to.be.false;
    });

    it("should correctly identify whitespace-only strings as invalid", () => {
      const testAddress: string = "   ";
      expect(isValidAddress(testAddress)).to.be.false;
    });

    it("should correctly identify valid addresses", () => {
      const testAddress: string = "0x1095bBe769fDab716A823d0f7149CAD713d20A13";
      expect(isValidAddress(testAddress)).to.be.true;
    });

    it("should correctly identify non-empty strings as valid", () => {
      const testAddress: string = "0x1234567890123456789012345678901234567890";
      expect(isValidAddress(testAddress)).to.be.true;
    });

    it("should correctly identify addresses with leading/trailing whitespace as valid", () => {
      const testAddress: string = "  0x1095bBe769fDab716A823d0f7149CAD713d20A13  ";
      expect(isValidAddress(testAddress)).to.be.true;
    });
  });

  describe("getValidAddress function", () => {
    it("should return trimmed valid address", () => {
      const testAddress = "  0x1095bBe769fDab716A823d0f7149CAD713d20A13  ";
      const result = getValidAddress(testAddress);
      expect(result).to.equal("0x1095bBe769fDab716A823d0f7149CAD713d20A13");
    });

    it("should return null for invalid addresses", () => {
      const testAddress = "invalid-address";
      const result = getValidAddress(testAddress);
      expect(result).to.be.null;
    });

    it("should return null for empty strings", () => {
      const testAddress = "";
      const result = getValidAddress(testAddress);
      expect(result).to.be.null;
    });

    it("should return null for whitespace-only strings", () => {
      const testAddress = "   ";
      const result = getValidAddress(testAddress);
      expect(result).to.be.null;
    });
  });

  describe("Comparison between isValidAddress and isAddress", () => {
    it("should handle invalid addresses differently", () => {
      const invalidAddresses = [
        "", // empty string
        "   ", // whitespace only
        "not-an-address", // invalid format
        "0x123", // too short
        "0x1234567890123456789012345678901234567890123456789012345678901234567890", // too long
      ];

      invalidAddresses.forEach(address => {
        // isValidAddress should return false for all invalid addresses
        expect(isValidAddress(address)).to.be.false;
        
        // isAddress should also return false for invalid addresses
        expect(isAddress(address)).to.be.false;
      });
    });

    it("should handle valid addresses consistently", () => {
      const validAddresses = [
        "0x1095bBe769fDab716A823d0f7149CAD713d20A13",
        "0x1234567890123456789012345678901234567890",
        "0x1095bBe769fDab716A823d0f7149CAD713d20A13  ", // with trailing whitespace
        "  0x1095bBe769fDab716A823d0f7149CAD713d20A13", // with leading whitespace
      ];

      validAddresses.forEach(address => {
        // isValidAddress should return true for valid addresses (after trimming)
        expect(isValidAddress(address)).to.be.true;
        
        // isAddress should return true for valid addresses (after trimming)
        expect(isAddress(address.trim())).to.be.true;
      });
    });
  });

  describe("Whitespace handling bug fix", () => {
    it("should handle addresses with whitespace without throwing errors", () => {
      const addressWithWhitespace = "  0x1095bBe769fDab716A823d0f7149CAD713d20A13  ";
      
      // This should not throw an error
      expect(() => {
        const validAddress = getValidAddress(addressWithWhitespace);
        if (validAddress) {
          toChecksumAddress(validAddress);
        }
      }).to.not.throw();
    });

    it("should properly trim addresses before validation", () => {
      const addressWithWhitespace = "  0x1095bBe769fDab716A823d0f7149CAD713d20A13  ";
      const trimmedAddress = "0x1095bBe769fDab716A823d0f7149CAD713d20A13";
      
      expect(isValidAddress(addressWithWhitespace)).to.be.true;
      expect(getValidAddress(addressWithWhitespace)).to.equal(trimmedAddress);
    });
  });
}); 