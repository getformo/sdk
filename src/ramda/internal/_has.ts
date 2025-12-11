export default function _has(prop: any, obj: any) {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}
