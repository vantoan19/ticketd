import { useLayoutEffect, useRef, useState } from "react";
import { fittingTags } from "./ticket-row";
import { Badge } from "@/components/ui/badge";

/**
 * Line two's tag pills: as many whole pills as the line has room for (half of
 * it), the others as one "+N" pill. Layout is measured, so a wide pane shows
 * `backend` `payments` and a narrow one `backend` `+1`.
 */
export function RowTags({ tags }: { tags: readonly string[] }) {
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
      setShown(fittingTags(widths.current, line.clientWidth / 2));
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(fit);
    observer.observe(line);
    return () => observer.disconnect();
  }, [key, tags.length, shown]);
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
