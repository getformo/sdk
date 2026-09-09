import { expect } from "chai";
import { stringifyAnalyticsJson } from "../../src/utils/stringifyAnalyticsJson";
const ASSERT = (actual: unknown, expected: unknown) => { expect(actual).to.deep.equal(expected); };

describe("stringifyAnalyticsJson", () => {
  it("encodes nested integers outside the parser range without mutating inputs", () => {
    const input = { arbitrary: 262198996219020150000, nested: [-(2 ** 64), { large: 1e30 }], volume: -1500.05 };
    const result = JSON.parse(stringifyAnalyticsJson(input));
    ASSERT(result, { arbitrary: "262198996219020150000", nested: [String(-(2 ** 64)), { large: "1e+30" }], volume: -1500.05 });
    ASSERT(typeof input.arbitrary, "number");
    // The gateway parses and reserializes properties: string encoding survives.
    ASSERT(JSON.parse(JSON.stringify(result)), result);
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

  it("retains native circular-reference errors", () => {
    const input: { self?: unknown } = {};
    input.self = input;
    expect(() => stringifyAnalyticsJson(input)).to.throw(TypeError);
  });
});
