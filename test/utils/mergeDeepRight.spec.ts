import { describe, it } from "mocha";
import { expect } from "chai";
import { mergeDeepRight } from "../../src/utils/mergeDeepRight";

/**
 * This replaced a vendored copy of ramda's `mergeDeepRight`. The cases below
 * pin the exact semantics that copy had, because the SDK's event context and
 * payload merging depend on them.
 */
describe("mergeDeepRight", () => {
  it("lets the right-hand value win for scalars", () => {
    expect(mergeDeepRight({ a: 1, b: 2 }, { b: 3 })).to.deep.equal({ a: 1, b: 3 });
  });

  it("keeps left-only keys", () => {
    expect(mergeDeepRight({ a: 1 }, { b: 2 })).to.deep.equal({ a: 1, b: 2 });
  });

  it("merges nested plain objects rather than replacing them", () => {
    expect(
      mergeDeepRight({ ctx: { a: 1, keep: "yes" } }, { ctx: { a: 2 } })
    ).to.deep.equal({ ctx: { a: 2, keep: "yes" } });
  });

  it("merges to arbitrary depth", () => {
    expect(
      mergeDeepRight({ a: { b: { c: { d: 1, e: 2 } } } }, { a: { b: { c: { d: 9 } } } })
    ).to.deep.equal({ a: { b: { c: { d: 9, e: 2 } } } });
  });

  it("replaces arrays wholesale instead of merging them", () => {
    // The vendored version only recursed into plain objects, so an array on
    // either side is overwritten. Event properties rely on this.
    expect(mergeDeepRight({ xs: [1, 2, 3] }, { xs: [9] })).to.deep.equal({ xs: [9] });
  });

  it("replaces non-plain objects wholesale", () => {
    const date = new Date(0);
    expect(mergeDeepRight({ v: { a: 1 } }, { v: date }).v).to.equal(date);
    expect(mergeDeepRight({ v: date }, { v: { a: 1 } }).v).to.deep.equal({ a: 1 });
  });

  it("treats null and undefined as values, not objects to merge into", () => {
    expect(mergeDeepRight({ a: { b: 1 } }, { a: null })).to.deep.equal({ a: null });
    expect(mergeDeepRight({ a: { b: 1 } }, { a: undefined })).to.deep.equal({ a: undefined });
  });

  it("treats nullish inputs as empty objects", () => {
    expect(mergeDeepRight(null as any, { a: 1 })).to.deep.equal({ a: 1 });
    expect(mergeDeepRight({ a: 1 }, null as any)).to.deep.equal({ a: 1 });
    expect(mergeDeepRight(undefined as any, undefined as any)).to.deep.equal({});
  });

  it("copies own enumerable keys only", () => {
    const parent = { inherited: "no" };
    const child = Object.create(parent);
    child.own = "yes";
    expect(mergeDeepRight({}, child)).to.deep.equal({ own: "yes" });
    expect(mergeDeepRight(child, {})).to.deep.equal({ own: "yes" });
  });

  it("is not confused by a key named hasOwnProperty", () => {
    const weird = { hasOwnProperty: "not a function" } as any;
    expect(() => mergeDeepRight(weird, { a: 1 })).to.not.throw();
    expect(mergeDeepRight(weird, { a: 1 })).to.deep.equal({
      hasOwnProperty: "not a function",
      a: 1,
    });
  });

  it("mutates neither input, at any depth", () => {
    const left = { a: { b: 1 }, keep: 1 };
    const right = { a: { c: 2 } };
    const out = mergeDeepRight(left, right);

    expect(left).to.deep.equal({ a: { b: 1 }, keep: 1 });
    expect(right).to.deep.equal({ a: { c: 2 } });
    expect(out.a).to.not.equal(left.a);
    expect(out.a).to.not.equal(right.a);
  });

  it("does not let a payload's __proto__ key reach Object.prototype", () => {
    const malicious = JSON.parse('{"__proto__": {"polluted": "yes"}}');
    mergeDeepRight({}, malicious);
    expect(({} as any).polluted, "prototype is intact").to.be.undefined;
  });
});
