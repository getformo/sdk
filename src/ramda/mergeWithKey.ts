import _curry3 from "./internal/_curry3";
import _has from "./internal/_has";

const mergeWithKey = _curry3(function mergeWithKey(
  fn: Function,
  l: any,
  r: any
) {
  const result: any = {};
  let k;
  l = l || {};
  r = r || {};

  for (k in l) {
    if (_has(k, l)) {
      result[k] = _has(k, r) ? fn(k, l[k], r[k]) : l[k];
    }
  }

  for (k in r) {
    if (_has(k, r) && !_has(k, result)) {
      result[k] = r[k];
    }
  }

  return result;
});
export default mergeWithKey;
