/**
 * A zod schema that is built on first use instead of when its module loads.
 * Building every bridge schema at module scope cost startup about 15 ms (180 ms
 * at 4x CPU) before the first screen; the proxy keeps each schema's type and
 * validation, so callers use it exactly like the schema `build` returns.
 */
export function lazySchema<T extends object>(build: () => T): T {
  let schema: T | undefined;
  const built = () => (schema ??= build());
  return new Proxy({} as T, {
    get: (_, key) => Reflect.get(built(), key),
    has: (_, key) => Reflect.has(built(), key),
    getPrototypeOf: () => Reflect.getPrototypeOf(built()),
  });
}
