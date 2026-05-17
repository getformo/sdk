import { describe, it } from "mocha";
import { expect } from "chai";
import {
  looksLikeRawSignature,
  redactSignatureHash,
  redactTypedDataMessage,
} from "../../src/utils/signatureRedaction";

// A realistic 65-byte ECDSA signature (130 hex chars).
const RAW_SIG = "0x" + "ab".repeat(65);
const COMPACT_SIG = "0x" + "cd".repeat(64); // EIP-2098, 128 hex
const HEX_130 = /0x[0-9a-fA-F]{128,}/;

describe("signatureRedaction", () => {
  describe("looksLikeRawSignature", () => {
    it("detects raw ECDSA / compact / long contract signatures", () => {
      expect(looksLikeRawSignature(RAW_SIG)).to.equal(true);
      expect(looksLikeRawSignature(COMPACT_SIG)).to.equal(true);
      expect(looksLikeRawSignature("0x" + "ff".repeat(200))).to.equal(true);
    });
    it("does not flag short tokens, hashes, or non-strings", () => {
      expect(looksLikeRawSignature("0xsignature123")).to.equal(false);
      expect(looksLikeRawSignature("a3f9c1b2")).to.equal(false); // secureHash output
      expect(looksLikeRawSignature(undefined)).to.equal(false);
      expect(looksLikeRawSignature(12345 as any)).to.equal(false);
    });
  });

  describe("redactSignatureHash", () => {
    it("never returns the raw signature", () => {
      const out = redactSignatureHash(RAW_SIG);
      expect(out).to.not.equal(RAW_SIG);
      expect(out).to.match(/^[0-9a-f]+$/);
      expect(RAW_SIG).to.not.contain(out!); // token is not a substring of the sig
    });
    it("is deterministic (stable correlation token)", () => {
      expect(redactSignatureHash(RAW_SIG)).to.equal(redactSignatureHash(RAW_SIG));
    });
    it("passes through already-safe values and undefined unchanged", () => {
      expect(redactSignatureHash("0xshort")).to.equal("0xshort");
      expect(redactSignatureHash(undefined)).to.equal(undefined);
    });
  });

  describe("redactTypedDataMessage", () => {
    // A Permit2 / permit-style typed data — the dangerous payload.
    const typedData = {
      domain: { name: "USD Coin", version: "2", chainId: 1, verifyingContract: "0xA0b8" },
      primaryType: "Permit",
      types: { Permit: [{ name: "owner", type: "address" }] },
      message: {
        owner: "0xVictim",
        spender: "0xAttacker",
        value: "115792089237316195423570985008687907853269984665640564039457584007913129639935",
        nonce: 7,
        deadline: 9999999999,
      },
    };

    it("emits only primaryType + domain.name/chainId", () => {
      const out = redactTypedDataMessage(typedData);
      expect(JSON.parse(out)).to.deep.equal({
        primaryType: "Permit",
        domain: { name: "USD Coin", chainId: 1 },
      });
    });

    it("never leaks the signed terms (spender / value / deadline / nonce / types)", () => {
      for (const input of [typedData, JSON.stringify(typedData)]) {
        const out = redactTypedDataMessage(input);
        expect(out).to.not.contain("0xAttacker");
        expect(out).to.not.contain("spender");
        expect(out).to.not.contain("deadline");
        expect(out).to.not.contain("nonce");
        expect(out).to.not.contain("115792089"); // the approved amount
        expect(out).to.not.contain("verifyingContract");
        expect(out).to.not.contain("types");
      }
    });

    it("returns '' for unparseable / empty input rather than echoing it", () => {
      expect(redactTypedDataMessage("{not json")).to.equal("");
      expect(redactTypedDataMessage(undefined)).to.equal("");
      expect(redactTypedDataMessage({})).to.equal("");
    });
  });

  it("end-to-end: a redacted signature event carries no replayable data", () => {
    const emitted = {
      status: "confirmed",
      signatureHash: redactSignatureHash(RAW_SIG),
      message: redactTypedDataMessage({
        domain: { name: "Seaport", chainId: 1 },
        primaryType: "OrderComponents",
        message: { offerer: "0xVictim", consideration: "everything" },
      }),
    };
    const serialized = JSON.stringify(emitted);
    expect(serialized).to.not.match(HEX_130);
    expect(serialized).to.not.contain("offerer");
    expect(serialized).to.not.contain("consideration");
  });
});
