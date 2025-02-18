import { describe, it } from "mocha";
import { toSnakeCase } from "../src/lib";
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
