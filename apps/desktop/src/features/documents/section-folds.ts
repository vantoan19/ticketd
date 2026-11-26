import { useCallback, useMemo, useState } from "react";
import {
  foldAllIntros,
  foldAllTargets,
  hiddenBy,
} from "@/features/markdown/folding";
import type { OutlineHeading } from "@/features/markdown/outline";

// Folds are kept per Document under their own key, not as a preference: a preference is one
// value for the whole app, and a Workspace Document's folds are only this computer's reading state.
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

// A section with subsections can also be folded to its first sentence while its subsections
// stay on show (Fold all does that). That state is kept beside the whole folds under
// "intro:{anchor}": an anchor is made of letters, digits and hyphens, so the two never collide.
const INTRO = "intro:";

export type SectionFolds = {
  /** Anchors of the sections folded away whole. */
  folded: ReadonlySet<string>;
  /** Anchors of the sections folded to their first sentence, their subsections still shown. */
  introFolded: ReadonlySet<string>;
  /** Folds an open section, or opens a folded one (a section folded to its first sentence gets its text back). */
  toggle: (id: string) => void;
  /** Folds every section to its heading and first sentence, subsections shown folded. */
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
  const [folded, introFolded] = useMemo(() => {
    const live = new Set(
      headings.filter((heading) => heading.foldable).map((h) => h.id),
    );
    return [
      new Set(ids.filter((id) => live.has(id))),
      new Set(
        ids
          .filter((id) => id.startsWith(INTRO))
          .map((id) => id.slice(INTRO.length))
          .filter((id) => live.has(id)),
      ),
    ];
  }, [ids, headings]);
  const targets = useMemo(() => foldAllTargets(headings), [headings]);
  const intros = useMemo(() => foldAllIntros(headings), [headings]);

  const change = useCallback(
    (next: readonly string[]) => {
      setStored({ documentId, ids: [...next] });
      if (documentId !== null) remember(documentId, next);
    },
    [documentId],
  );
  const entries = (
    wholeFolds: Iterable<string>,
    introFolds: Iterable<string>,
  ) => [...wholeFolds, ...[...introFolds].map((id) => `${INTRO}${id}`)];
  return {
    folded,
    introFolded,
    toggle: (id) => {
      const without = (set: ReadonlySet<string>) =>
        [...set].filter((other) => other !== id);
      if (folded.has(id)) change(entries(without(folded), introFolded));
      else if (introFolded.has(id))
        change(entries(folded, without(introFolded)));
      else change(entries([...folded, id], introFolded));
    },
    foldAll: () =>
      change(
        entries(
          new Set([...folded, ...targets]),
          new Set([...introFolded, ...intros]),
        ),
      ),
    unfoldAll: () => change([]),
    reveal: (id) => {
      const hiding = new Set(hiddenBy(headings, id, folded));
      if (hiding.size > 0)
        change(
          entries(
            [...folded].filter((o) => !hiding.has(o)),
            introFolded,
          ),
        );
    },
    allFolded:
      targets.every((id) => folded.has(id)) &&
      intros.every((id) => introFolded.has(id)),
  };
}
