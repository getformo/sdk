import _curry3 from "./internal/_curry3";
import _isObject from "./internal/_isObject";
import mergeWithKey from "./mergeWithKey";

const mergeDeepWithKey = _curry3(function mergeDeepWithKey(
  fn: Function,
  lObj: any,
  rObj: any
) {
  return mergeWithKey(
    function (k: Function, lVal: any, rVal: any) {
      if (_isObject(lVal) && _isObject(rVal)) {
        return mergeDeepWithKey(fn, lVal, rVal);
      } else {
        return fn(k, lVal, rVal);
      }
    },
    lObj,
    rObj
  );
});
export default mergeDeepWithKey;
