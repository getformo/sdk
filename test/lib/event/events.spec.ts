import { describe, it } from "mocha";
import { expect } from "chai";
import { toChecksumAddress } from "../../../src/utils";

describe("Address checksumming fix", () => {
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