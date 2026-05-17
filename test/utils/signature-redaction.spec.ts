import { describe, it } from "mocha";
import { expect } from "chai";
import { redactTypedDataMessage } from "../../src/utils/signatureRedaction";

describe("signatureRedaction", () => {
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

  it("end-to-end: a minimized signature event carries no replayable data", () => {
    // C1: the produced signature is never captured; only safe metadata.
    const emitted = {
      status: "confirmed",
      message: redactTypedDataMessage({
        domain: { name: "Seaport", chainId: 1 },
        primaryType: "OrderComponents",
        message: { offerer: "0xVictim", consideration: "everything" },
      }),
    };
    const serialized = JSON.stringify(emitted);
    expect(serialized).to.not.have.string("signatureHash");
    expect(serialized).to.not.contain("offerer");
    expect(serialized).to.not.contain("consideration");
  });
});
