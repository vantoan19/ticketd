import { useState } from "react";

const NONE: ReadonlySet<string> = new Set();

type Seen = {
  signature: string;
  keys: ReadonlySet<string>;
  pages: number;
  arrived: ReadonlySet<string>;
};

/**
 * The entries that are new since the last render: a change arriving while the
 * Inbox is open. Nothing is new on the first settled render, nor when the
 * list only grew because "Show more" was pressed, so a page of fifty rows
 * never animates at once.
 */
export function useArrivals(
  keys: readonly string[],
  settled: boolean,
  pages: number,
): ReadonlySet<string> {
  const [seen, setSeen] = useState<Seen | null>(null);
  const signature = keys.join("\n");
  if (settled && seen?.signature !== signature)
    setSeen({
      signature,
      keys: new Set(keys),
      pages,
      arrived:
        seen && seen.pages === pages
          ? new Set(keys.filter((key) => !seen.keys.has(key)))
          : NONE,
    });
  return seen?.arrived ?? NONE;
}
