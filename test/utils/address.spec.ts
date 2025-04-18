import { describe, it } from "mocha";
import { expect } from "chai";
import { toChecksumAddress } from "../../src/utils";

describe("toChecksumAddress", () => {
  it("should return the checksum of the address", () => {
    expect(
      toChecksumAddress("0x82827Bc8342a16b681AfbA6B979E3D1aE5F28a0e")
    ).to.equal("0x82827Bc8342a16b681AfbA6B979E3D1aE5F28a0e");
    expect(
      toChecksumAddress("0x82827bc8342a16b681afba6b979e3d1ae5f28a0e")
    ).to.equal("0x82827Bc8342a16b681AfbA6B979E3D1aE5F28a0e");
  });
});
