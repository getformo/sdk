import { describe, it } from "mocha";
import { expect } from "chai";
import { toSnakeCase } from "../../src/utils";

describe("toSnakeCase", () => {
  it("should convert object keys to snake case", () => {
    expect(
      toSnakeCase({ chainId: "12345", hashMessage: "John Doe" })
    ).to.deep.equal({
      chain_id: "12345",
      hash_message: "John Doe",
    });
  });

  it("should preserve Date objects without corruption", () => {
    const date = new Date("2024-01-01T00:00:00Z");
    const result = toSnakeCase({ createdAt: date });
    expect(result).to.deep.equal({ created_at: date });
    expect(result.created_at).to.be.instanceOf(Date);
  });

  it("should preserve Uint8Array without corruption", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const result = toSnakeCase({ rawData: bytes });
    expect(result).to.deep.equal({ raw_data: bytes });
    expect(result.raw_data).to.be.instanceOf(Uint8Array);
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
