import _curry1 from "./_curry1";
import _isPlaceholder from "./_isPlaceholder";

/**
 * Optimized internal two-arity curry function.
 *
 * @private
 * @category Function
 * @param {Function} fn The function to curry.
 * @return {Function} The curried function.
 */
export default function _curry2(fn: Function) {
  return function f2(a: any, b: any) {
    switch (arguments.length) {
      case 0:
        return f2;
      case 1:
        return _isPlaceholder(a)
          ? f2
          : _curry1(function (_b: any) {
              return fn(a, _b);
            });
      default:
        return _isPlaceholder(a) && _isPlaceholder(b)
          ? f2
          : _isPlaceholder(a)
          ? _curry1(function (_a: any) {
              return fn(_a, b);
            })
          : _isPlaceholder(b)
          ? _curry1(function (_b: any) {
              return fn(a, _b);
            })
          : fn(a, b);
    }
  };
}
