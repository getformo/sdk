import { expect } from "chai";
import { runInNewContext } from "vm";
import { stringifyAnalyticsJson } from "../../src/utils/stringifyAnalyticsJson";
const ASSERT = (actual: unknown, expected: unknown) => { expect(actual).to.deep.equal(expected); };

describe("stringifyAnalyticsJson", () => {
  it("avoids Number slot checks for ordinary nested payloads", () => {
    const original = Number.prototype.valueOf;
    let calls = 0;
    Number.prototype.valueOf = function () { calls++; return original.call(this); };
    try {
      const input = Array.from({ length: 100 }, () => ({ properties: { amount: 12.5, tags: ["a", "b"] } }));
      ASSERT(stringifyAnalyticsJson(input), JSON.stringify(input));
      ASSERT(calls, 0);
      ASSERT(stringifyAnalyticsJson(new Number(1e30)), '"1e+30"');
      ASSERT(calls, 2); // Slot validation, then native ToNumber conversion.
    } finally {
      Number.prototype.valueOf = original;
    }
  });

  it("does not read custom tag getters and still normalizes tagged boxes", () => {
    const fake = { keep: true };
    const box = new Number(1e30);
    for (const object of [fake, box]) {
      Object.defineProperty(object, Symbol.toStringTag, { get() { throw new Error("tag must not be read"); } });
    }
    ASSERT(stringifyAnalyticsJson({ fake, box }), '{"fake":{"keep":true},"box":"1e+30"}');
  });
  it("encodes nested integers outside the parser range without mutating inputs", () => {
    const input = { arbitrary: 262198996219020150000, nested: [-(2 ** 64), { large: 1e30 }], volume: -1500.05 };
    const result = JSON.parse(stringifyAnalyticsJson(input));
    ASSERT(result, { arbitrary: "262198996219020150000", nested: [String(-(2 ** 64)), { large: "1e+30" }], volume: -1500.05 });
    ASSERT(typeof input.arbitrary, "number");
    // Assert the downstream wire form, not just an object's self-round-trip.
    ASSERT(JSON.stringify(result), '{"arbitrary":"262198996219020150000","nested":["-18446744073709552000",{"large":"1e+30"}],"volume":-1500.05}');
  });

  it("preserves numeric types inside the signed/unsigned 64-bit parser range", () => {
    const values = [0, -1, 1.25, -(2 ** 63) + 1024, 2 ** 64 - 2048, Number.MAX_SAFE_INTEGER];
    ASSERT(JSON.parse(stringifyAnalyticsJson(values)), values);
    ASSERT(JSON.parse(stringifyAnalyticsJson([2 ** 64, -(2 ** 63), -(2 ** 63) - 2048])), [String(2 ** 64), String(-(2 ** 63)), String(-(2 ** 63) - 2048)]);
  });

  it("preserves ordinary JSON semantics, Dates and toJSON", () => {
    const input = { text: 'quote"\\newline\n', nil: null, missing: undefined, values: [NaN, Infinity, -Infinity, undefined], date: new Date("2026-09-09T00:00:00Z") };
    ASSERT(stringifyAnalyticsJson(input), JSON.stringify(input));
    ASSERT(JSON.parse(stringifyAnalyticsJson({ toJSON: () => ({ value: 1e30 }) })), { value: "1e+30" });
  });

  it("preserves text, booleans, tiny fractions and ordinary integer precision semantics", () => {
    const input = { text: "18446744073709551616", flag: false, tiny: 1e-300, safe: Number.MAX_SAFE_INTEGER, alreadyRounded: Number.MAX_SAFE_INTEGER + 1, minusZero: -0 };
    ASSERT(stringifyAnalyticsJson(input), JSON.stringify(input));
  });

  it("protects extreme fields returned by nested toJSON hooks", () => {
    const input = { context: { toJSON: () => ({ measurement: Number.MAX_VALUE }) }, properties: { values: [-Number.MAX_VALUE, 1e21] } };
    ASSERT(JSON.parse(stringifyAnalyticsJson(input)), {
      context: { measurement: String(Number.MAX_VALUE) },
      properties: { values: [String(-Number.MAX_VALUE), "1e+21"] },
    });
  });

  it("normalizes boxed extreme numbers and preserves ordinary boxed values", () => {
    const input = { upper: new Number(2 ** 64), lower: new Number(-(2 ** 63)), nested: [new Number(1e30)], normal: new Number(-12.5), infinity: new Number(Infinity) };
    ASSERT(stringifyAnalyticsJson(input), '{"upper":"18446744073709552000","lower":"-9223372036854776000","nested":["1e+30"],"normal":-12.5,"infinity":null}');
    ASSERT(input.upper.valueOf(), 2 ** 64);
  });

  it("uses custom boxed-number conversion exactly once", () => {
    let calls = 0;
    const box = new Number(1);
    box.valueOf = () => { calls++; return 2 ** 64; };
    ASSERT(stringifyAnalyticsJson({ box }), '{"box":"18446744073709552000"}');
    ASSERT(calls, 1);
    box.valueOf = () => { calls++; return 7; };
    ASSERT(stringifyAnalyticsJson({ box }), '{"box":7}');
    ASSERT(calls, 2);
  });

  it("does not treat number-like objects or spoofed tags as boxed numbers", () => {
    const fake = { [Symbol.toStringTag]: "Number", valueOf: () => 2 ** 64, keep: true };
    ASSERT(stringifyAnalyticsJson({ fake }), JSON.stringify({ fake }));
    ASSERT(stringifyAnalyticsJson({ string: new String("hello"), bool: new Boolean(false) }), JSON.stringify({ string: new String("hello"), bool: new Boolean(false) }));
  });

  it("normalizes boxed numbers from another realm", () => {
    const box = runInNewContext("new Number(2 ** 64)");
    ASSERT(box instanceof Number, false);
    ASSERT(stringifyAnalyticsJson({ box }), '{"box":"18446744073709552000"}');
  });

  it("honors Symbol.toPrimitive on boxed numbers with a number hint", () => {
    const box = new Number(0);
    Object.defineProperty(box, Symbol.toPrimitive, { value: (hint: string) => {
      ASSERT(hint, "number");
      return -(2 ** 63);
    } });
    ASSERT(stringifyAnalyticsJson({ box }), '{"box":"-9223372036854776000"}');
  });

  it("preserves boxed conversion errors", () => {
    const box = new Number(1);
    box.valueOf = () => { throw new TypeError("conversion failed"); };
    expect(() => stringifyAnalyticsJson(box)).to.throw(TypeError);
  });

  it("retains native circular-reference errors", () => {
    const input: { self?: unknown } = {};
    input.self = input;
    expect(() => stringifyAnalyticsJson(input)).to.throw(TypeError);
  });
});
