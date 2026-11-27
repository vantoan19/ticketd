import {
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { Tooltip } from "@/components/ui/tooltip";
import { fitTitle } from "./file-name";

/** Measures text in the font the element draws with; null where there is no canvas (a test). */
function measureIn(element: Element): ((text: string) => number) | null {
  if (typeof OffscreenCanvas === "undefined") return null;
  const context = new OffscreenCanvas(1, 1).getContext("2d");
  if (!context) return null;
  // The `font` shorthand reads empty in some engines, so it is assembled.
  const style = getComputedStyle(element);
  context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  return (text) => context.measureText(text).width;
}

/**
 * The viewer header's name: one line that gives way in the middle, as a card's
 * name does, so its end and extension stay visible. The full name is the
 * tooltip while it is cut and stays the accessible name.
 */
export function FittedTitle({
  name,
  heading,
}: {
  name: string;
  /** The heading element (dialog title or pane h2) that holds the text. */
  heading: (text: ReactNode) => ReactElement;
}) {
  const host = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState(0);
  const [measure, setMeasure] = useState<((text: string) => number) | null>(
    null,
  );
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const update = () => setWidth(element.clientWidth);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    let active = true;
    const apply = () => {
      if (active)
        setMeasure(() => measureIn(element.firstElementChild ?? element));
    };
    apply();
    // Geist may arrive after the first measure.
    void document.fonts?.ready.then(apply);
    return () => {
      active = false;
    };
  }, []);
  const fitted = measure ? fitTitle(name, width, measure) : null;
  const shown = fitted?.cut ? (
    <>
      <span aria-hidden="true">{fitted.text}</span>
      <span className="sr-only">{name}</span>
    </>
  ) : (
    name
  );
  return (
    <span ref={host} className="attachment-preview-title">
      <Tooltip content={name} side="bottom" disabled={!fitted?.cut}>
        {heading(shown)}
      </Tooltip>
    </span>
  );
}
