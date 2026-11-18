import { useLayoutEffect, useRef, useState } from "react";
import { fittingTags } from "./ticket-row";
import { Badge } from "@/components/ui/badge";

// One observer serves every row's tag line: a list or board has hundreds.
let lines: ResizeObserver | null = null;
const refits = new Map<Element, () => void>();
function observeLine(line: Element, fit: () => void) {
  lines ??= new ResizeObserver((entries) => {
    for (const entry of entries) refits.get(entry.target)?.();
  });
  refits.set(line, fit);
  lines.observe(line);
  return () => {
    refits.delete(line);
    lines?.unobserve(line);
  };
}

/**
 * Line two's tag pills: as many whole pills as the line has room for (half of
 * it), the others as one "+N" pill. Layout is measured, so a wide pane shows
 * `backend` `payments` and a narrow one `backend` `+1`.
 */
export function RowTags({
  tags,
  ledger = false,
}: {
  tags: readonly string[];
  ledger?: boolean;
}) {
  const box = useRef<HTMLSpanElement>(null);
  const widths = useRef<number[] | null>(null);
  const [shown, setShown] = useState(tags.length);
  const key = tags.join("\u0000");
  const measuredKey = useRef(key);
  useLayoutEffect(() => {
    const element = box.current;
    const line = element?.parentElement;
    if (!element || !line) return;
    const fit = () => {
      if (measuredKey.current !== key) {
        measuredKey.current = key;
        widths.current = null;
      }
      // No layout (hidden list, test DOM): the first tag and a count.
      if (line.clientWidth === 0) return setShown(1);
      if (widths.current === null) {
        const pills = element.querySelectorAll<HTMLElement>("[data-tag]");
        if (pills.length !== tags.length) {
          // Only some pills are drawn: draw them all, then measure.
          setShown(tags.length);
          return;
        }
        const measured = [...pills].map((pill) => pill.scrollWidth);
        if (measured.some((width) => width === 0)) return setShown(1);
        widths.current = measured;
      }
      setShown(
        Math.min(
          ledger ? 3 : tags.length,
          fittingTags(widths.current, line.clientWidth / (ledger ? 1 : 2)),
        ),
      );
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    return observeLine(line, fit);
  }, [key, tags.length, shown, ledger]);
  if (tags.length === 0) return null;
  const visible = Math.min(shown, tags.length);
  const more = tags.length - visible;
  return (
    <span className="ticket-row-tags" ref={box}>
      {tags.slice(0, visible).map((tag) => (
        <Badge size="sm" data-tag key={tag}>
          {tag}
        </Badge>
      ))}
      {more > 0 && (
        <Badge size="sm" data-more title={tags.slice(visible).join(", ")}>
          +{more}
        </Badge>
      )}
    </span>
  );
}
