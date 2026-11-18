import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Count } from "@/components/ui/count";
import { Expand } from "@/components/ui/motion";
import { renderedLines } from "@/components/ui/rendered-lines";
import "./disclosure.css";
import "./patterns.css";

/**
 * A labelled section that opens in place: a 16px chevron that turns down,
 * the label at 14/20 and an optional count. One level only; it replaces every
 * raw `<details>`. Closed content stays mounted but inert. It opens on the
 * smooth spring while its rows fade up one after another (the first seven), and
 * closes with the height while the content fades. Controlled with `open` and
 * `onOpenChange`, or left to itself with `defaultOpen`.
 */
export function Disclosure({
  label,
  count,
  defaultOpen = false,
  open: controlled,
  onOpenChange,
  className,
  children,
}: {
  label: ReactNode;
  count?: number;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  children: ReactNode;
}) {
  const [own, setOwn] = useState(defaultOpen);
  const open = controlled ?? own;
  const body = useId();
  return (
    <div data-slot="disclosure" className={className}>
      <button
        type="button"
        className="ui-disclosure-trigger"
        aria-expanded={open}
        aria-controls={body}
        onClick={() => {
          setOwn(!open);
          onOpenChange?.(!open);
        }}
      >
        <ChevronRight aria-hidden="true" />
        <span>{label}</span>
        {count !== undefined && <Count>{count}</Count>}
      </button>
      {/* Kept mounted while closed, as <details> is, so state inside survives;
          Expand keeps it inert and out of the accessibility tree. */}
      <Expand open={open}>
        <div id={body} className="ui-disclosure-body">
          {children}
        </div>
      </Expand>
    </div>
  );
}

/**
 * Long text kept to about `lines` lines with a fade, then "Show more" and
 * "Show less" at the text edge. Whether to clamp is decided by the rendered
 * line count, never by characters, so a one-line message never offers more.
 */
export function Clamp({
  lines = 8,
  className,
  children,
}: {
  lines?: number;
  className?: string;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element || expanded) return;
    const measure = () => setOverflows(renderedLines(element) > lines);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [expanded, children, lines]);
  const id = useId();
  return (
    <div data-slot="clamp" className={className}>
      <div
        ref={box}
        id={id}
        className="ui-clamp-body"
        data-clamped={expanded ? undefined : ""}
        style={{ "--clamp-lines": lines } as React.CSSProperties}
      >
        {children}
      </div>
      {(overflows || expanded) && (
        <div className="ui-clamp-toggle">
          <Button
            variant="link"
            size="inline"
            aria-expanded={expanded}
            aria-controls={id}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "Show less" : "Show more"}
          </Button>
        </div>
      )}
    </div>
  );
}
