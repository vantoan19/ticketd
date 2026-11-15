/**
 * After a row is removed, the next row moves up under the pointer, so a
 * double-click would remove it too. A removal within 400ms of the last one
 * through the same guard is ignored (P7). Returns whether to go ahead.
 */
export function allowRemoval(last: { current: number }): boolean {
  const now = Date.now();
  if (now - last.current < 400) return false;
  last.current = now;
  return true;
}
