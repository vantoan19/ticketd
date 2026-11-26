import type { OutlineHeading } from "./outline";

/**
 * What "Fold all" folds whole: every section that has no subsection of its own, so the
 * Document reads as its headings, each with its first sentence. A section that holds
 * subsections is folded to its first sentence by [`foldAllIntros`] and keeps them on show.
 */
export function foldAllTargets(headings: readonly OutlineHeading[]): string[] {
  return foldableSections(headings)
    .filter((heading) => !heading.parent)
    .map((heading) => heading.id);
}

/**
 * What "Fold all" folds to its first sentence only: the sections that hold subsections. Their
 * text before the first subsection steps aside; the subsections stay on show, each folded.
 */
export function foldAllIntros(headings: readonly OutlineHeading[]): string[] {
  return foldableSections(headings)
    .filter((heading) => heading.parent)
    .map((heading) => heading.id);
}

/** Each foldable heading, and whether a foldable subsection follows it. */
function foldableSections(headings: readonly OutlineHeading[]) {
  const foldable = headings.filter((heading) => heading.foldable);
  return foldable.map((heading, index) => {
    const next = foldable[index + 1];
    return {
      id: heading.id,
      parent: next !== undefined && next.level > heading.level,
    };
  });
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
