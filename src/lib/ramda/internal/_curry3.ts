import _curry1 from "./_curry1";
import _curry2 from "./_curry2";
import _isPlaceholder from "./_isPlaceholder";

/**
 * Optimized internal three-arity curry function.
 *
 * @private
 * @category Function
 * @param {Function} fn The function to curry.
 * @return {Function} The curried function.
 */
export default function _curry3(fn: Function) {
  return function f3(a: any, b: any, c: any) {
    switch (arguments.length) {
      case 0:
        return f3;
      case 1:
        return _isPlaceholder(a)
          ? f3
          : _curry2(function (_b: any, _c: any) {
              return fn(a, _b, _c);
            });
      case 2:
        return _isPlaceholder(a) && _isPlaceholder(b)
          ? f3
          : _isPlaceholder(a)
          ? _curry2(function (_a: any, _c: any) {
              return fn(_a, b, _c);
            })
          : _isPlaceholder(b)
          ? _curry2(function (_b: any, _c: any) {
              return fn(a, _b, _c);
            })
          : _curry1(function (_c: any) {
              return fn(a, b, _c);
            });
      default:
        return _isPlaceholder(a) && _isPlaceholder(b) && _isPlaceholder(c)
          ? f3
          : _isPlaceholder(a) && _isPlaceholder(b)
          ? _curry2(function (_a: any, _b: any) {
              return fn(_a, _b, c);
            })
          : _isPlaceholder(a) && _isPlaceholder(c)
          ? _curry2(function (_a: any, _c: any) {
              return fn(_a, b, _c);
            })
          : _isPlaceholder(b) && _isPlaceholder(c)
          ? _curry2(function (_b: any, _c: any) {
              return fn(a, _b, _c);
            })
          : _isPlaceholder(a)
          ? _curry1(function (_a: any) {
              return fn(_a, b, c);
            })
          : _isPlaceholder(b)
          ? _curry1(function (_b: any) {
              return fn(a, _b, c);
            })
          : _isPlaceholder(c)
          ? _curry1(function (_c: any) {
              return fn(a, b, _c);
            })
          : fn(a, b, c);
    }
  };
}
