import { expect, test, vi } from "vitest";
import { z } from "zod";
import { lazySchema } from "./lazy-schema";

test("a lazy schema is built on its first parse, once, and validates as built", () => {
  const build = vi.fn(() => z.object({ id: z.string() }));
  const schema = lazySchema(build);
  const list = lazySchema(() => z.array(schema));
  expect(build).not.toHaveBeenCalled();

  expect(list.parse([{ id: "a" }])).toEqual([{ id: "a" }]);
  expect(() => schema.parse({ id: 1 })).toThrow(z.ZodError);
  expect(schema.extend({ n: z.number() }).parse({ id: "b", n: 1 })).toEqual({
    id: "b",
    n: 1,
  });
  expect(schema).toBeInstanceOf(z.ZodObject);
  expect(build).toHaveBeenCalledTimes(1);
});
