import { describe, it } from "mocha";
import { expect } from "chai";
import { stableStringify } from "../../../src/utils/generate";

describe("stableStringify bigint through a hook", () => {
  it("throws for a bigint returned by a toJSON hook, as JSON.stringify does", () => {
    const proto = BigInt.prototype as unknown as { toJSON?: () => string };
    proto.toJSON = function () { return this.toString(); };
    try {
      expect(() => stableStringify({ p: { toJSON: () => BigInt(1) } })).to.throw(TypeError);
    } finally {
      delete proto.toJSON;
    }
  });
});

describe("stableStringify", () => {
  it("sorts keys at every depth", () => {
    expect(stableStringify({ b: 2, a: { d: 1, c: [1] } })).to.equal('{"a":{"c":[1],"d":1},"b":2}');
  });

  it("returns undefined where JSON.stringify would", () => {
    expect(stableStringify(undefined)).to.equal(undefined);
    expect(stableStringify(() => 1)).to.equal(undefined);
  });

  it("omits undefined, symbol and function values, as JSON.stringify does", () => {
    const value = { u: undefined, s: Symbol("s"), f: () => 1, kept: 1 };
    expect(stableStringify(value)).to.equal(JSON.stringify(value));
  });

  it("honors a toJSON hook on a function value", () => {
    const fn = Object.assign(() => undefined, { toJSON: () => "fn" });
    expect(stableStringify({ f: fn })).to.equal(JSON.stringify({ f: fn }));
  });

  it("reads a toJSON hook once", () => {
    let reads = 0;
    const flaky = { a: 1, get toJSON() { reads++; return reads === 1 ? () => "once" : undefined; } };
    expect(stableStringify({ p: flaky })).to.equal('{"p":"once"}');
  });

  it("honors a hook that returns its own object, serializing it by its fields", () => {
    const self = { a: 1, toJSON() { return self; } };
    expect(stableStringify({ p: self })).to.equal(JSON.stringify({ p: self }));
  });

  it("honors a BigInt.prototype.toJSON hook", () => {
    const proto = BigInt.prototype as unknown as { toJSON?: () => string };
    proto.toJSON = function () { return this.toString(); };
    try {
      expect(stableStringify({ amount: BigInt(123) })).to.equal(JSON.stringify({ amount: BigInt(123) }));
    } finally {
      delete proto.toJSON;
    }
  });

  it("throws on a bigint without a hook, as JSON.stringify does", () => {
    expect(() => stableStringify({ amount: BigInt(5) })).to.throw(TypeError);
  });

  it("calls a hook through Reflect.apply, not through an overridden call", () => {
    const hook = Object.assign(() => "ok", { call: () => { throw new Error("overridden"); } });
    expect(stableStringify({ p: { toJSON: hook } })).to.equal(JSON.stringify({ p: { toJSON: hook } }));
  });

  it("serializes without BigInt in the runtime", () => {
    const saved = (global as any).BigInt;
    (global as any).BigInt = undefined;
    try {
      expect(stableStringify({ b: 2, a: { d: 1, c: [1] } })).to.equal('{"a":{"c":[1],"d":1},"b":2}');
    } finally {
      (global as any).BigInt = saved;
    }
  });

  it("rejects a boxed bigint", () => {
    expect(() => stableStringify({ n: Object(BigInt(1)) })).to.throw(TypeError);
  });

  it("reads an array length once, as JSON.stringify does", () => {
    let reads = 0;
    const growing = new Proxy([1, 2], { get: (t, p, r) => { if (p === "length") { reads++; if (reads > 1) t.push(0); } return Reflect.get(t, p, r); } });
    expect(stableStringify({ a: growing })).to.equal('{"a":[1,2]}');
  });
});
