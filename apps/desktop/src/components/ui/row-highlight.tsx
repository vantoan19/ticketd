import { useContext, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { HighlightGroup } from "@/components/ui/highlight-group";
import { Glide } from "@/components/ui/motion";

/**
 * The highlight of a menu, select or list row (DESIGN.md section 12). With the
 * keyboard it is the Glide that travels from row to row; with the pointer it
 * follows at once, as a plain fill in the row under it.
 *
 * A list names its rows' group with `HighlightGroup` (highlight-group.ts) and
 * each row renders `RowHighlight` as a child. The row needs
 * `position: relative`. The Glide's fill is set in styles.css, where the lists
 * are.
 */

// Whether the latest input was the pointer or a key. A single listener pair
// serves every row, as the tooltip's navigation tracking does.
let viaPointer = false;
let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  document.addEventListener("pointermove", () => (viaPointer = true), true);
  document.addEventListener("keydown", () => (viaPointer = false), true);
}

/**
 * The fill of the row it sits in while the row is highlighted: Radix marks it
 * `data-highlighted`, cmdk `data-selected="true"`.
 */
export function RowHighlight({
  attribute = "data-highlighted",
}: {
  attribute?: "data-highlighted" | "data-selected";
}) {
  const group = useContext(HighlightGroup);
  const marker = useRef<HTMLSpanElement>(null);
  const [mode, setMode] = useState<"keyboard" | "pointer" | null>(null);
  useLayoutEffect(() => {
    listen();
    const row = marker.current?.parentElement;
    if (!row) return;
    const read = () => {
      const on =
        row.hasAttribute(attribute) && row.getAttribute(attribute) !== "false";
      return on ? (viaPointer ? "pointer" : "keyboard") : null;
    };
    // A layout effect re-renders before paint; later changes flush at once, so
    // the fill is there in the frame the highlight moves.
    setMode(read());
    const observer = new MutationObserver(() =>
      flushSync(() => setMode(read())),
    );
    observer.observe(row, { attributes: true, attributeFilter: [attribute] });
    return () => observer.disconnect();
  }, [attribute]);
  return (
    <>
      <span ref={marker} hidden />
      {mode === "keyboard" && group !== null ? (
        <Glide id={group} />
      ) : (
        mode !== null && (
          <span
            data-slot="highlight"
            aria-hidden="true"
            className="ui-glide bg-accent"
          />
        )
      )}
    </>
  );
}
