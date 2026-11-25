import { useId, useRef, useState, type KeyboardEvent } from "react";
import { flushSync } from "react-dom";
import { outlineView, type OutlineHeading } from "@/features/markdown/outline";

/**
 * The ticks the outline shows beside the list: a section's tick is long, a
 * subsection's short, and the popover lists the sections with the current
 * section's subsections. `headings` and `current` are the outline's data; the
 * full-width rail and folding read the same.
 */
export function DocumentOutline({
  headings,
  current,
  onChoose,
  folds,
}: {
  headings: readonly OutlineHeading[];
  /** The anchor of the heading the reader is at. */
  current: string | null;
  onChoose: (heading: OutlineHeading) => void;
  /** Fold all and Unfold all, shown above the sections when there is something to fold. */
  folds?: {
    folded: number;
    allFolded: boolean;
    foldAll: () => void;
    unfoldAll: () => void;
  };
}) {
  const [open, setOpen] = useState(false);
  const nav = useRef<HTMLElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const skipFocusOpen = useRef(false);
  const listId = useId();
  const here = current;
  const { sectionAt, shown, subsections } = outlineView(headings, here);

  const links = () =>
    Array.from(nav.current?.querySelectorAll<HTMLAnchorElement>("a") ?? []);
  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) {
      skipFocusOpen.current = true;
      button.current?.focus();
    }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const items = links();
    const index = items.indexOf(document.activeElement as HTMLAnchorElement);
    const move = (to: number) => {
      const item = items[to];
      if (!item) return;
      event.preventDefault();
      item.focus();
    };
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "ArrowDown") {
      // Reopen first when Escape closed it, so there is a link to move to.
      if (!open) flushSync(() => setOpen(true));
      const first = Math.max(
        0,
        shown.findIndex((h) => h.id === here),
      );
      const list = links();
      const item = list[index < 0 ? first : index + 1];
      if (item) {
        event.preventDefault();
        item.focus();
      }
    } else if (event.key === "ArrowUp" && index > 0) move(index - 1);
    else if (event.key === "Home" && index >= 0) move(0);
    else if (event.key === "End" && index >= 0) move(items.length - 1);
  };

  return (
    <nav
      ref={nav}
      className="document-outline"
      aria-label={`On this page, ${headings.length} headings`}
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => {
        // A link the pointer chose has focus without :focus-visible; leaving still closes.
        if (!nav.current?.querySelector(":focus-visible")) close(false);
      }}
      onBlur={(event) => {
        if (
          !nav.current?.contains(event.relatedTarget) &&
          !nav.current?.matches(":hover")
        )
          close(false);
      }}
      onKeyDown={onKeyDown}
    >
      <button
        ref={button}
        type="button"
        className="document-outline-ticks"
        aria-label="Show outline"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onFocus={() => {
          if (skipFocusOpen.current) skipFocusOpen.current = false;
          else setOpen(true);
        }}
      >
        {headings.map((heading) => (
          <i
            key={heading.id}
            data-tick={heading.section ? "section" : "subsection"}
            data-current={heading.id === here ? "" : undefined}
          />
        ))}
      </button>
      {open && (
        <div id={listId} className="document-outline-popover">
          <div className="document-outline-head">
            <p className="document-outline-title">On this page</p>
            {folds && (
              <span className="document-outline-actions">
                {!folds.allFolded && (
                  <button type="button" onClick={folds.foldAll}>
                    Fold all
                  </button>
                )}
                {folds.folded > 0 && (
                  <button type="button" onClick={folds.unfoldAll}>
                    Unfold all
                  </button>
                )}
              </span>
            )}
          </div>
          <ul>
            {shown.map((heading) => (
              <li key={heading.id}>
                <a
                  href={`#${heading.id}`}
                  data-level={heading.section ? "section" : "subsection"}
                  data-current={heading.id === here ? "" : undefined}
                  data-section-current={
                    heading.id === headings[sectionAt]?.id ? "" : undefined
                  }
                  aria-current={heading.id === here ? "location" : undefined}
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
        </div>
      )}
    </nav>
  );
}
