import type { OutlineHeading } from "./outline";

/**
 * What "Fold all" folds: every section that has no folded-away subsection of its
 * own, so the Document reads as its headings, each with its first sentence. A
 * section that holds subsections stays open and shows them folded.
 */
export function foldAllTargets(headings: readonly OutlineHeading[]): string[] {
  const foldable = headings.filter((heading) => heading.foldable);
  return foldable
    .filter((heading, index) => {
      const next = foldable[index + 1];
      return next === undefined || next.level <= heading.level;
    })
    .map((heading) => heading.id);
}

/**
 * The folded sections that hide this heading: the heading's own section and
 * every section around it, found by walking back to the nearest heading of each
 * shallower level.
 */
export function hiddenBy(
  headings: readonly OutlineHeading[],
  id: string,
  folded: ReadonlySet<string>,
): string[] {
  const at = headings.findIndex((heading) => heading.id === id);
  if (at === -1) return [];
  const found = folded.has(id) ? [id] : [];
  let level = headings[at]?.level ?? 1;
  for (let index = at - 1; index >= 0; index -= 1) {
    const heading = headings[index];
    if (!heading || heading.level >= level) continue;
    level = heading.level;
    if (folded.has(heading.id)) found.push(heading.id);
  }
  return found;
}
