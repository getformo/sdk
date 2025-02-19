import { describe, it } from "mocha";
import { isAddress, toSnakeCase } from "../src/lib";
import { expect } from "chai";

describe("toSnakeCase", () => {
  it("should convert object keys to snake case", () => {
    expect(
      toSnakeCase({ chainId: "12345", hashMessage: "John Doe" })
    ).to.deep.equal({
      chain_id: "12345",
      hash_message: "John Doe",
    });
  });

  it("should convert object keys to snake case, omitting keys in the omitKeys array", () => {
    expect(
      toSnakeCase(
        {
          chainId: "12345",
          hashMessage: "John Doe",
          "user-agent": "Mozilla/5.0",
        },
        ["user-agent"]
      )
    ).to.deep.equal({
      chain_id: "12345",
      hash_message: "John Doe",
      "user-agent": "Mozilla/5.0",
    });
  });
});

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
