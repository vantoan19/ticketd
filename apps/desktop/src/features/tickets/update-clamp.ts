/**
 * A line holding only an attachment link becomes a 176px card, which is taller
 * than eight lines of text: such an update clamps much later, so a card is
 * never faded out under a "Show more" that has nothing to show.
 */
export const ALONE_LINK =
  /^\s*(?:[-*+]\s+)?(?:<ticketd:\/\/attachment\/[^>\s]+>|\[[^\]]*\]\(ticketd:\/\/attachment\/[^)\s]+\))\s*$/m;

/** An attachment picture written into the text: `![alt](ticketd://attachment/…)`. */
const PICTURE = /!\[[^\]]*\]\(ticketd:\/\/attachment\/[^)\s]+\)/g;

/** A picture in an update stops at 240px: 12 lines of 20px text, plus its margin. */
const PICTURE_LINES = 14;

/**
 * How many lines of an update show before it is clamped: a few of text, later
 * for cards, and every picture adds its own height (up to 240px) on top, so a
 * paragraph with one picture is never cut short with "Show more" under it.
 */
export function updateClampLines(brief: string, textLines = 8): number {
  const pictures = brief.match(PICTURE)?.length ?? 0;
  return (ALONE_LINK.test(brief) ? 40 : textLines) + pictures * PICTURE_LINES;
}
