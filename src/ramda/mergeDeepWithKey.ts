import _curry3 from "./internal/_curry3";
import _isObject from "./internal/_isObject";
import mergeWithKey from "./mergeWithKey";

// Hard recursion ceiling. The merged objects (event context/properties)
// are public SDK input; a deeply-nested or circular host object must not
// recurse until a RangeError (which silently drops the event). Past this
// depth we stop deep-merging and apply `fn` directly — for mergeDeepRight
// that means "right value wins", the documented shallow-at-leaf behavior.
const MAX_MERGE_DEPTH = 64;

function mergeDeepWithKeyRecursive(
  fn: Function,
  lObj: any,
  rObj: any,
  depth: number
): any {
  return mergeWithKey(
    function (k: Function, lVal: any, rVal: any) {
      if (depth < MAX_MERGE_DEPTH && _isObject(lVal) && _isObject(rVal)) {
        return mergeDeepWithKeyRecursive(fn, lVal, rVal, depth + 1);
      }
      return fn(k, lVal, rVal);
    },
    lObj,
    rObj
  );
}

const mergeDeepWithKey = _curry3(function mergeDeepWithKey(
  fn: Function,
  lObj: any,
  rObj: any
) {
  return mergeDeepWithKeyRecursive(fn, lObj, rObj, 0);
});
export default mergeDeepWithKey;
