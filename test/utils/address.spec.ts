import { describe, it } from "mocha";
import { expect } from "chai";
import { toChecksumAddress, isBlockedAddress } from "../../src/utils";
import { validateAddress } from "../../src/utils/address";
import { ZERO_ADDRESS, DEAD_ADDRESS } from "../../src/constants";
import { SOLANA_CHAIN_IDS } from "../../src/solana/types";

describe("toChecksumAddress", () => {
  it("should return the checksum of the address", () => {
    expect(
      toChecksumAddress("0x82827Bc8342a16b681AfbA6B979E3D1aE5F28a0e")
    ).to.equal("0x82827Bc8342a16b681AfbA6B979E3D1aE5F28a0e");
    expect(
      toChecksumAddress("0x82827bc8342a16b681afba6b979e3d1ae5f28a0e")
    ).to.equal("0x82827Bc8342a16b681AfbA6B979E3D1aE5F28a0e");
  });

  it("should properly checksum the specific address from the issue", () => {
    const nonChecksummedAddress = "0x7e6ca77a7e044ba836a97beb796c124ca3a6a255";
    const expectedChecksummedAddress = "0x7E6CA77a7E044BA836a97beB796c124Ca3a6A255";
    
    const result = toChecksumAddress(nonChecksummedAddress);
    expect(result).to.equal(expectedChecksummedAddress);
  });

  it("should handle various address formats", () => {
    const testCases = [
      {
        input: "0x7e6ca77a7e044ba836a97beb796c124ca3a6a255",
        expected: "0x7E6CA77a7E044BA836a97beB796c124Ca3a6A255"
      },
      {
        input: "0x82827bc8342a16b681afba6b979e3d1ae5f28a0e",
        expected: "0x82827Bc8342a16b681AfbA6B979E3D1aE5F28a0e"
      }
    ];

    testCases.forEach(({ input, expected }) => {
      const result = toChecksumAddress(input);
      expect(result).to.equal(expected);
    });
  });

  it("should handle already checksummed addresses", () => {
    const checksummedAddress = "0x7E6CA77a7E044BA836a97beB796c124Ca3a6A255";
    const result = toChecksumAddress(checksummedAddress);
    expect(result).to.equal(checksummedAddress);
  });
});

describe("isBlockedAddress", () => {
  it("should return true for zero address", () => {
    expect(isBlockedAddress(ZERO_ADDRESS)).to.be.true;
    expect(isBlockedAddress("0x0000000000000000000000000000000000000000")).to.be.true;
    expect(isBlockedAddress("0x0000000000000000000000000000000000000000".toLowerCase())).to.be.true;
  });

  it("should return true for dead address", () => {
    expect(isBlockedAddress(DEAD_ADDRESS)).to.be.true;
    expect(isBlockedAddress("0x000000000000000000000000000000000000dEaD")).to.be.true;
    expect(isBlockedAddress("0x000000000000000000000000000000000000dead")).to.be.true;
    expect(isBlockedAddress("0x000000000000000000000000000000000000DEAD")).to.be.true;
  });

  it("should return false for normal addresses", () => {
    expect(isBlockedAddress("0x7E6CA77a7E044BA836a97beB796c124Ca3a6A255")).to.be.false;
    expect(isBlockedAddress("0x82827Bc8342a16b681AfbA6B979E3D1aE5F28a0e")).to.be.false;
  });

  it("should return false for null, undefined, or empty addresses", () => {
    expect(isBlockedAddress(null)).to.be.false;
    expect(isBlockedAddress(undefined)).to.be.false;
    expect(isBlockedAddress("")).to.be.false;
    expect(isBlockedAddress("   ")).to.be.false;
  });

  it("should return false for invalid addresses", () => {
    expect(isBlockedAddress("not-an-address")).to.be.false;
    expect(isBlockedAddress("0x123")).to.be.false;
    expect(isBlockedAddress("0x1234567890123456789012345678901234567890123456789012345678901234567890")).to.be.false;
  });

  it("should handle addresses with different casing", () => {
    // Test that the function correctly handles different case versions of the same blocked address
    const zeroAddressVariants = [
      "0x0000000000000000000000000000000000000000",
      "0X0000000000000000000000000000000000000000",
      "0x0000000000000000000000000000000000000000".toLowerCase(),
      "0x0000000000000000000000000000000000000000".toUpperCase(),
    ];

    zeroAddressVariants.forEach(variant => {
      expect(isBlockedAddress(variant)).to.be.true;
    });

    const deadAddressVariants = [
      "0x000000000000000000000000000000000000dEaD",
      "0x000000000000000000000000000000000000dead",
      "0x000000000000000000000000000000000000DEAD",
      "0X000000000000000000000000000000000000DEAD",
    ];

    deadAddressVariants.forEach(variant => {
      expect(isBlockedAddress(variant)).to.be.true;
    });
  });
});

describe("validateAddress", () => {
  const VALID_EVM = "0x82827Bc8342a16b681AfbA6B979E3D1aE5F28a0e";
  const VALID_SOLANA = "FDKJvWcJNe6wecbgDYDFPCfgs14aJnVsUfWQRYWLn4Tn";

  it("should validate EVM address when explicit EVM chainId is provided", () => {
    expect(validateAddress(VALID_EVM, 1)).to.equal(VALID_EVM);
  });

  it("should reject Solana address when explicit EVM chainId is provided", () => {
    expect(validateAddress(VALID_SOLANA, 1)).to.be.undefined;
    expect(validateAddress(VALID_SOLANA, 137)).to.be.undefined;
  });

  it("should validate Solana address when explicit Solana chainId is provided", () => {
    expect(validateAddress(VALID_SOLANA, SOLANA_CHAIN_IDS["mainnet-beta"])).to.equal(VALID_SOLANA);
    expect(validateAddress(VALID_SOLANA, SOLANA_CHAIN_IDS["devnet"])).to.equal(VALID_SOLANA);
  });

  it("should reject EVM address when explicit Solana chainId is provided", () => {
    expect(validateAddress(VALID_EVM, SOLANA_CHAIN_IDS["mainnet-beta"])).to.be.undefined;
  });

  it("should try EVM first then Solana fallback when no chainId", () => {
    expect(validateAddress(VALID_EVM)).to.equal(VALID_EVM);
    expect(validateAddress(VALID_SOLANA)).to.equal(VALID_SOLANA);
  });

  it("should return undefined for invalid addresses", () => {
    expect(validateAddress("not-an-address")).to.be.undefined;
    expect(validateAddress("not-an-address", 1)).to.be.undefined;
    expect(validateAddress("not-an-address", SOLANA_CHAIN_IDS["mainnet-beta"])).to.be.undefined;
  });
});
