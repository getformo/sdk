import { describe, it, afterEach } from "mocha";
import { expect } from "chai";
import { toSnakeCase } from "../../src/utils";
import mergeDeepRight from "../../src/ramda/mergeDeepRight";

// Use JSON.parse so `__proto__` / `constructor` become *own enumerable*
// properties (a `{ __proto__: ... }` object literal is the prototype
// setter, not an own key — that wouldn't reproduce the attack).
const malicious = (k: string) =>
  JSON.parse(`{"${k}": {"polluted": true}}`);

describe("prototype pollution guards", () => {
  afterEach(() => {
    // Fail loudly if any case leaked onto the global prototype.
    delete (Object.prototype as any).polluted;
  });

  for (const key of ["__proto__", "constructor", "prototype"]) {
    it(`toSnakeCase drops own '${key}' key without polluting`, () => {
      const out = toSnakeCase(malicious(key));
      expect(({} as any).polluted).to.equal(undefined);
      expect(Object.prototype.hasOwnProperty.call(out, key)).to.equal(false);
    });

    it(`mergeDeepRight ignores own '${key}' key without polluting`, () => {
      const out = mergeDeepRight({ safe: 1 }, malicious(key));
      expect(({} as any).polluted).to.equal(undefined);
      expect((out as any).safe).to.equal(1);
      expect(Object.prototype.hasOwnProperty.call(out, key)).to.equal(false);
    });
  }

  it("toSnakeCase still converts and keeps legitimate keys", () => {
    expect(toSnakeCase({ chainId: "1", hashMessage: "x" })).to.deep.equal({
      chain_id: "1",
      hash_message: "x",
    });
  });

  it("mergeDeepRight still deep-merges legitimate keys", () => {
    expect(
      mergeDeepRight({ a: { x: 1 }, b: 2 }, { a: { y: 3 } })
    ).to.deep.equal({ a: { x: 1, y: 3 }, b: 2 });
  });
});
