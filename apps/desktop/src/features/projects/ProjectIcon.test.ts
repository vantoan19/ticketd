import { expect, test } from "vitest";
import { readsAsShape } from "@/features/projects/favicon";

/** A 16×16 alpha channel as RGBA bytes, opaque wherever `inside` holds. */
function image(inside: (x: number, y: number) => boolean) {
  const data = new Uint8ClampedArray(16 * 16 * 4);
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++)
      data[(y * 16 + x) * 4 + 3] = inside(x, y) ? 255 : 0;
  return data;
}

test("an opaque tile with rounded corners is a picture, not a shape", () => {
  const corner = (x: number, y: number) =>
    Math.hypot(Math.max(3 - x, x - 12, 0), Math.max(3 - y, y - 12, 0)) > 3.5;
  expect(readsAsShape(image((x, y) => !corner(x, y)))).toBe(false);
});

test("a glyph on a transparent ground is a shape", () => {
  // A triangle, as a logo drawn without a tile.
  expect(
    readsAsShape(image((x, y) => y > 3 && Math.abs(x - 8) < (y - 3) / 2)),
  ).toBe(true);
});

test("a fully opaque square is a picture", () => {
  expect(readsAsShape(image(() => true))).toBe(false);
});
