import { expect } from "chai";
import { describe, it } from "mocha";
import { isAddress } from "../../src/validators";

describe("isAddress", () => {
  it("should return true if the input is a valid ethereum address", () => {
    expect(isAddress("0xa5cc3c03994DB5b0d9A5eEdD10CabaB0813678AC")).to.equal(
      true
    );
  });

  it("should return false otherwise", () => {
    expect(isAddress("o")).to.equal(false);
  });
});
