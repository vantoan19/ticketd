/** Ordered letters match a label without requiring a literal substring. */
export function searchMatch(text: string, query: string): number[] | null {
  const haystack = text.toLocaleLowerCase();
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const literal = haystack.indexOf(needle);
  if (literal >= 0)
    return Array.from({ length: needle.length }, (_, i) => literal + i);
  const indices: number[] = [];
  let from = 0;
  for (const letter of needle.replace(/\s/g, "")) {
    const index = haystack.indexOf(letter, from);
    if (index < 0) return null;
    indices.push(index);
    from = index + 1;
  }
  return indices;
}
