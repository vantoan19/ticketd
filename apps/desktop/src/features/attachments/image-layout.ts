export type Size = { width: number; height: number };

/** A tiny picture is drawn at least this many pixels on its short side (shell AT-09). */
const MIN_SHORT_SIDE = 128;

/**
 * The scale at which the whole picture sits inside `room`, never past 100%, except that
 * a tiny picture is drawn at least `MIN_SHORT_SIDE` pixels on its short side (when the
 * room allows).
 */
export function fitScale(natural: Size, room: Size) {
  const inside = Math.min(
    room.width / natural.width,
    room.height / natural.height,
  );
  const floor = MIN_SHORT_SIDE / Math.min(natural.width, natural.height);
  const wanted = Math.min(Math.max(1, floor), inside);
  return Number.isFinite(wanted) && wanted > 0 ? wanted : 1;
}
