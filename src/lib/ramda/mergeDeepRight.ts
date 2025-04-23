import _curry2 from "./internal/_curry2";
import mergeDeepWithKey from "./mergeDeepWithKey";

const mergeDeepRight = _curry2(function mergeDeepRight(lObj: any, rObj: any) {
  return mergeDeepWithKey(
    function (_: Function, __: any, rVal: any) {
      return rVal;
    },
    lObj,
    rObj
  );
});
export default mergeDeepRight;
