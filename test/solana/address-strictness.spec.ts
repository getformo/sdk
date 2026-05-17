import { describe, it } from "mocha";
import { expect } from "chai";
import { isSolanaAddress } from "../../src/solana/address";
import { isBlockedAddress } from "../../src/utils/address";
import { SOLANA_SYSTEM_ADDRESSES } from "../../src/solana/address";

describe("isSolanaAddress: 32-byte decode enforcement", () => {
  it("rejects a Base58 string in the length window that does not decode to 32 bytes", () => {
    // 44 'z' chars: valid Base58 charset + within 32–44 length, but
    // decodes to >32 bytes — must be rejected now.
    expect(isSolanaAddress("z".repeat(44))).to.equal(false);
    // 32 'z' chars: in range, decodes to fewer than 32 bytes.
    expect(isSolanaAddress("z".repeat(32))).to.equal(false);
  });

  it("still accepts real 32-byte public keys", () => {
    expect(
      isSolanaAddress("FDKJvWcJNe6wecbgDYDFPCfgs14aJnVsUfWQRYWLn4Tn")
    ).to.equal(true);
    expect(
      isSolanaAddress(SOLANA_SYSTEM_ADDRESSES.SYSTEM_PROGRAM)
    ).to.equal(true);
  });
});

describe("isBlockedAddress: chain-aware", () => {
  it("blocks Solana system/program addresses via the generic check", () => {
    expect(isBlockedAddress(SOLANA_SYSTEM_ADDRESSES.SYSTEM_PROGRAM)).to.equal(
      true
    );
    expect(isBlockedAddress(SOLANA_SYSTEM_ADDRESSES.TOKEN_PROGRAM)).to.equal(
      true
    );
  });

  it("does not block a normal Solana wallet address", () => {
    expect(
      isBlockedAddress("FDKJvWcJNe6wecbgDYDFPCfgs14aJnVsUfWQRYWLn4Tn")
    ).to.equal(false);
  });

  it("preserves EVM blocklist behavior", () => {
    expect(
      isBlockedAddress("0x0000000000000000000000000000000000000000")
    ).to.equal(true);
    expect(
      isBlockedAddress("0x82827Bc8342a16b681AfbA6B979E3D1aE5F28a0e")
    ).to.equal(false);
  });
});
