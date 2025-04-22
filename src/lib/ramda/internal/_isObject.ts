export default function _isObject(x: any) {
  return Object.prototype.toString.call(x) === "[object Object]";
}
