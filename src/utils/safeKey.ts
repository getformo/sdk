/**
 * Prototype-pollution guard.
 *
 * Assigning these keys onto a plain object mutates its prototype chain
 * (`obj.__proto__ = …`) or shadows constructor internals. Any code path
 * that copies caller-controlled keys into an accumulator object — deep
 * merges, snake_case conversion, payload builders — must reject them.
 *
 * Public SDK methods (`track`, `identify`, `page`, …) accept arbitrary
 * `properties`/`context`, and a malicious provider or site script can
 * supply objects whose own keys are `__proto__`/`constructor`/`prototype`
 * (e.g. via `JSON.parse`), so this is enforced at every such sink.
 */
export const UNSAFE_OBJECT_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

export const isUnsafeObjectKey = (key: PropertyKey): boolean =>
  typeof key === "string" && UNSAFE_OBJECT_KEYS.has(key);
