import { useCallback, useMemo, useState } from "react";
import { foldAllTargets, hiddenBy } from "@/features/markdown/folding";
import type { OutlineHeading } from "@/features/markdown/outline";

const key = (documentId: string) => `ticketd.document-folds.${documentId}`;

function recall(documentId: string): string[] {
  try {
    const raw = localStorage.getItem(key(documentId));
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

function remember(documentId: string, ids: readonly string[]) {
  try {
    if (ids.length === 0) localStorage.removeItem(key(documentId));
    else localStorage.setItem(key(documentId), JSON.stringify(ids));
  } catch {
    // The folds still work this time; they are just not kept.
  }
}

export type SectionFolds = {
  /** Anchors of the folded sections. */
  folded: ReadonlySet<string>;
  toggle: (id: string) => void;
  /** Folds every section that holds no folded-away subsection. */
  foldAll: () => void;
  unfoldAll: () => void;
  /** Unfolds whatever hides this heading, so it can be scrolled to. */
  reveal: (id: string) => void;
  /** Whether Fold all would change nothing. */
  allFolded: boolean;
};

/**
 * Which sections of a Document are folded. Folds belong to the Document and the
 * computer: they are kept in local storage and never touch the Markdown.
 * `documentId` is null for a Document that does not exist yet, which has none.
 */
export function useSectionFolds(
  documentId: string | null,
  headings: readonly OutlineHeading[],
): SectionFolds {
  const [stored, setStored] = useState(() => ({
    documentId,
    ids: documentId === null ? [] : recall(documentId),
  }));
  let ids = stored.ids;
  if (stored.documentId !== documentId) {
    ids = documentId === null ? [] : recall(documentId);
    setStored({ documentId, ids });
  }
  // A heading that was renamed or removed leaves its fold behind; it is ignored.
  const folded = useMemo(() => {
    const live = new Set(
      headings.filter((heading) => heading.foldable).map((h) => h.id),
    );
    return new Set(ids.filter((id) => live.has(id)));
  }, [ids, headings]);
  const targets = useMemo(() => foldAllTargets(headings), [headings]);

  const change = useCallback(
    (next: readonly string[]) => {
      setStored({ documentId, ids: [...next] });
      if (documentId !== null) remember(documentId, next);
    },
    [documentId],
  );
  return {
    folded,
    toggle: (id) =>
      change(
        folded.has(id)
          ? [...folded].filter((other) => other !== id)
          : [...folded, id],
      ),
    foldAll: () => change([...new Set([...folded, ...targets])]),
    unfoldAll: () => change([]),
    reveal: (id) => {
      const hiding = new Set(hiddenBy(headings, id, folded));
      if (hiding.size > 0) change([...folded].filter((o) => !hiding.has(o)));
    },
    allFolded: targets.every((id) => folded.has(id)),
  };
}
