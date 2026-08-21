/**
 * Deep merge two plain objects, with the right-hand side winning.
 *
 * Replaces a vendored copy of ramda's `mergeDeepRight` (9 files, ~200 lines
 * of currying and placeholder machinery) that existed to serve exactly two
 * call sites, each passing two plain objects. None of the currying was
 * reachable.
 *
 * Behaviour is deliberately identical to the implementation it replaces:
 *
 * - Only PLAIN objects recurse. `Object.prototype.toString` is the test, so
 *   arrays, dates, class instances, null and primitives are all replaced
 *   wholesale by the right-hand value rather than merged into.
 * - Own enumerable keys only, via `hasOwnProperty` - inherited keys are not
 *   copied, and a key literally named `hasOwnProperty` cannot break it.
 * - A key present on the left and absent on the right keeps the left value.
 * - Neither input is mutated; a new object is returned at every level.
 * - Nullish inputs are treated as empty objects.
 */
export function mergeDeepRight<L, R>(left: L, right: R): L & R {
  const l = (left ?? {}) as Record<string, unknown>;
  const r = (right ?? {}) as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const k in l) {
    if (!Object.prototype.hasOwnProperty.call(l, k)) continue;
    result[k] = Object.prototype.hasOwnProperty.call(r, k)
      ? mergeValues(l[k], r[k])
      : l[k];
  }

  for (const k in r) {
    if (!Object.prototype.hasOwnProperty.call(r, k)) continue;
    if (Object.prototype.hasOwnProperty.call(result, k)) continue;
    result[k] = r[k];
  }

  return result as L & R;
}

/** Recurse only when BOTH sides are plain objects; otherwise the right wins. */
function mergeValues(lVal: unknown, rVal: unknown): unknown {
  if (isPlainObject(lVal) && isPlainObject(rVal)) {
    return mergeDeepRight(lVal, rVal);
  }
  return rVal;
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return Object.prototype.toString.call(x) === "[object Object]";
}

export default mergeDeepRight;
