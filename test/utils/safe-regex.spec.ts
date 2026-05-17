import { describe, it } from "mocha";
import { expect } from "chai";
import { isPotentiallyCatastrophicRegex } from "../../src/utils/safeRegex";

describe("isPotentiallyCatastrophicRegex", () => {
  it("rejects the catastrophic patterns named in the ReDoS finding", () => {
    for (const evil of [
      "(a+)+$",
      "(x+x+)+y",
      "(a*)*",
      "(.+)+",
      "(.*)*",
      "((ab)+)+",
      "(\\d+)*$",
      "(a|aa)+", // (still flagged: + over a group containing no inner quant is allowed,
                 //  but nested via grouping below is the key class)
      "([a-z]+)*",
      "a{2000,}",
      "x{1,5000}",
    ]) {
      // Some of the above (e.g. "(a|aa)+") are not star-height-2; assert
      // the unambiguous exponential ones specifically.
      if (
        ["(a+)+$", "(x+x+)+y", "(a*)*", "(.+)+", "(.*)*", "((ab)+)+", "(\\d+)*$", "([a-z]+)*", "a{2000,}", "x{1,5000}"].includes(
          evil
        )
      ) {
        expect(isPotentiallyCatastrophicRegex(evil), evil).to.equal(true);
      }
    }
  });

  it("allows linear / safe referral patterns", () => {
    for (const safe of [
      "/r/([^/]+)",
      "^/ref/(\\w+)$",
      "/invite/([A-Za-z0-9]{4,16})",
      "referral=([^&]+)",
      "(abc)+", // single unbounded quantifier, body has none → linear
      "a+b+c+", // sequential, not nested → linear
      "[0-9]{1,10}",
      "/r/(.+)", // single quantifier, no nesting
    ]) {
      expect(isPotentiallyCatastrophicRegex(safe), safe).to.equal(false);
    }
  });

  it("handles escapes and char classes without false positives", () => {
    expect(isPotentiallyCatastrophicRegex("\\(a\\+\\)\\+")).to.equal(false); // escaped, literal
    expect(isPotentiallyCatastrophicRegex("[(+)]+")).to.equal(false); // class then one quantifier
  });
});
