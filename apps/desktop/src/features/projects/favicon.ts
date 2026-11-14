/** Below this share of opaque pixels, a favicon is a glyph on a clear ground. */
const TILE = 0.75;

/**
 * Whether a 16px favicon (RGBA bytes) reads as its shape alone: mostly clear.
 * A tile with rounded corners shows through at its corners yet is a picture.
 */
export function readsAsShape(rgba: Uint8ClampedArray): boolean {
  let opaque = 0;
  const pixels = rgba.length / 4;
  for (let index = 3; index < rgba.length; index += 4)
    if ((rgba[index] ?? 0) >= 128) opaque++;
  return opaque < pixels * TILE;
}
