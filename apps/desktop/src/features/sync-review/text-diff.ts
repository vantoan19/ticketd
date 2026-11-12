export type DiffPart = { text: string; changed: boolean };

/** Cells of the comparison table above which the differing middle is marked whole. */
const MAX_CELLS = 1_000_000;

function parts(tokens: string[], changed: boolean[]): DiffPart[] {
  const out: DiffPart[] = [];
  tokens.forEach((text, index) => {
    const flag = changed[index] ?? false;
    const last = out[out.length - 1];
    if (last && last.changed === flag) last.text += text;
    else if (text) out.push({ text, changed: flag });
  });
  return out;
}

/**
 * Word-level comparison of two texts: each side's words the other lacks are
 * marked changed. Joining a side's parts gives that side's text back.
 */
export function diffWords(
  before: string,
  after: string,
): { before: DiffPart[]; after: DiffPart[] } {
  const a = before.split(/(\s+)/);
  const b = after.split(/(\s+)/);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const changedA = a.map((_, index) => index >= start && index < endA);
  const changedB = b.map((_, index) => index >= start && index < endB);
  const rows = endA - start;
  const columns = endB - start;
  // ponytail: a very large rewrite is marked whole instead of word by word;
  // switch to a linear-space diff (Myers) if that ever reads badly.
  if (rows > 0 && columns > 0 && rows * columns <= MAX_CELLS) {
    // Longest common subsequence of the differing middle, filled from the end.
    const width = columns + 1;
    const table = new Uint32Array((rows + 1) * width);
    for (let i = rows - 1; i >= 0; i--)
      for (let j = columns - 1; j >= 0; j--)
        table[i * width + j] =
          a[start + i] === b[start + j]
            ? (table[(i + 1) * width + j + 1] ?? 0) + 1
            : Math.max(
                table[(i + 1) * width + j] ?? 0,
                table[i * width + j + 1] ?? 0,
              );
    let i = 0;
    let j = 0;
    while (i < rows && j < columns) {
      if (a[start + i] === b[start + j]) {
        changedA[start + i++] = false;
        changedB[start + j++] = false;
      } else if (
        (table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)
      )
        i++;
      else j++;
    }
  }
  return { before: parts(a, changedA), after: parts(b, changedB) };
}
