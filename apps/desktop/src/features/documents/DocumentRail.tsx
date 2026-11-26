import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { outlineView, type OutlineHeading } from "@/features/markdown/outline";
import { readingScrollBehavior } from "./reading-scroll";

/** Whether the reader has scrolled past the first screen of `scroller`. */
function usePastFirstScreen(scroller: HTMLElement | null) {
  const [past, setPast] = useState(false);
  useEffect(() => {
    if (!scroller) return;
    const measure = () =>
      setPast(scroller.scrollTop > Math.max(scroller.clientHeight, 1));
    measure();
    scroller.addEventListener("scroll", measure, { passive: true });
    return () => scroller.removeEventListener("scroll", measure);
  }, [scroller]);
  return past;
}

/**
 * The outline at full width (DESIGN.md section 8): a 200 px rail right of the
 * column, where the ticks and popover sit beside the list. It lists the
 * sections and the current section's subsections, folds and unfolds them all,
 * offers Back to top once the reader is past the first screen, and holds what
 * the Document is linked to (`children`). The rail stays in view while the
 * Document scrolls.
 */
export function DocumentRail({
  headings,
  current,
  onChoose,
  folds,
  scroller,
  children,
}: {
  headings: readonly OutlineHeading[];
  /** The anchor of the heading the reader is at. */
  current: string | null;
  onChoose: (heading: OutlineHeading) => void;
  folds: {
    folded: number;
    allFolded: boolean;
    foldAll: () => void;
    unfoldAll: () => void;
  };
  scroller: HTMLElement | null;
  /** The Linked list; the rail says nothing about it when it has nothing to list. */
  children?: ReactNode;
}) {
  const { sectionAt, shown, subsections } = outlineView(headings, current);
  const past = usePastFirstScreen(scroller);
  const nav = useRef<HTMLElement>(null);
  return (
    // A zero-height track that sticks to the reader's top: the rail hangs from it.
    <div className="document-rail-track">
      <div className="document-rail">
        <nav ref={nav} aria-label={`On this page, ${headings.length} headings`}>
          <div className="document-rail-head">
            <p className="document-rail-title">On this page</p>
            <span className="document-rail-actions">
              {!folds.allFolded && (
                <Button variant="ghost" size="compact" onClick={folds.foldAll}>
                  Fold all
                </Button>
              )}
              {folds.folded > 0 && (
                <Button
                  variant="ghost"
                  size="compact"
                  onClick={folds.unfoldAll}
                >
                  Unfold all
                </Button>
              )}
            </span>
          </div>
          <ul>
            {shown.map((heading) => (
              <li key={heading.id}>
                <a
                  href={`#${heading.id}`}
                  data-level={heading.section ? "section" : "subsection"}
                  data-current={heading.id === current ? "" : undefined}
                  data-section-current={
                    heading.id === headings[sectionAt]?.id ? "" : undefined
                  }
                  aria-current={heading.id === current ? "location" : undefined}
                  onClick={(event) => {
                    event.preventDefault();
                    onChoose(heading);
                  }}
                >
                  {heading.text}
                  {heading.id === headings[sectionAt]?.id &&
                    subsections > 0 && (
                      <span className="document-outline-count">
                        {subsections}
                      </span>
                    )}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        {children}
        {past && (
          <Button
            variant="ghost"
            size="compact"
            className="document-rail-top"
            onClick={() => {
              if (!scroller) return;
              scroller.scrollTo({ top: 0, behavior: readingScrollBehavior() });
              // The button leaves once the reader is back at the top: focus stays in the rail.
              nav.current?.querySelector("a")?.focus();
            }}
          >
            <ChevronUp aria-hidden="true" />
            Back to top
          </Button>
        )}
      </div>
    </div>
  );
}
