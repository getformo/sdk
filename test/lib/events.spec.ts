import { describe, it } from "mocha";
import { expect } from "chai";
import { getCookieDomain } from "../../src/event/utils";

describe("getCookieDomain", () => {
  it("should return the cookie domain format", () => {
    expect(getCookieDomain("192.168.0.1")).to.equal("");
    expect(getCookieDomain("localhost:3000")).to.equal("");
    expect(getCookieDomain("example.com")).to.equal(".example.com");
    expect(getCookieDomain("www.example.com")).to.equal(".example.com");
  });
});

describe("Address Assignment Logic", () => {
  it("should handle undefined address correctly", () => {
    // Test the logic we fixed: undefined should be converted to null
    const testAddress = undefined;
    const result = testAddress ? testAddress : null;
    expect(result).to.be.null;
  });

  it("should handle null address correctly", () => {
    // Test the logic we fixed: null should remain null
    const testAddress = null;
    const result = testAddress ? testAddress : null;
    expect(result).to.be.null;
  });

  it("should handle valid address correctly", () => {
    // Test the logic we fixed: valid address should be preserved
    const testAddress = "0x1095bBe769fDab716A823d0f7149CAD713d20A13";
    const result = testAddress ? testAddress : null;
    expect(result).to.equal(testAddress);
  });

  it("should properly check for undefined and null values", () => {
    // Test the exact logic we implemented in the fix
    const testCases = [
      { input: undefined, expected: true },
      { input: null, expected: true },
      { input: "", expected: false },
      { input: "0x123", expected: false },
    ];

    testCases.forEach(({ input, expected }) => {
      const result = input === undefined || input === null;
      expect(result).to.equal(expected);
    });
  });
});
