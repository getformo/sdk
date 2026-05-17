import { describe, it } from "mocha";
import { expect } from "chai";
import { isPotentiallyCatastrophicRegex } from "../../src/utils/safeRegex";

describe("isPotentiallyCatastrophicRegex", () => {
  it("rejects star-height ≥ 2 / nested-quantifier patterns", () => {
    for (const evil of [
      "(a+)+$",
      "(x+x+)+y",
      "(a*)*",
      "(.+)+",
      "(.*)*",
      "((ab)+)+",
      "(\\d+)*$",
      "([a-z]+)*",
    ]) {
      expect(isPotentiallyCatastrophicRegex(evil), evil).to.equal(true);
    }
  });

  it("rejects ambiguous / overlapping quantified-alternation patterns", () => {
    for (const evil of [
      "(a|a)+",
      "(a|ab)+",
      "([a-z]|\\w)+",
      "(.*|.*)+",
      "(foo|foo)*",
      "^/(x|x)+$",
    ]) {
      expect(isPotentiallyCatastrophicRegex(evil), evil).to.equal(true);
    }
  });

  it("rejects oversized bounded repetitions", () => {
    expect(isPotentiallyCatastrophicRegex("a{2000,}")).to.equal(true);
    expect(isPotentiallyCatastrophicRegex("x{1,5000}")).to.equal(true);
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
      "/(r|ref)/[^/]+", // alternation NOT under an unbounded quantifier → safe
    ]) {
      expect(isPotentiallyCatastrophicRegex(safe), safe).to.equal(false);
    }
  });

  it("handles escapes and char classes without false positives", () => {
    expect(isPotentiallyCatastrophicRegex("\\(a\\+\\)\\+")).to.equal(false); // escaped, literal
    expect(isPotentiallyCatastrophicRegex("[(+)]+")).to.equal(false); // class then one quantifier
    expect(isPotentiallyCatastrophicRegex("[a|b]+")).to.equal(false); // | inside class, not alternation
  });
});
