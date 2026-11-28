import {
  useId,
  useMemo,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from "react";
import { Tooltip } from "@/components/ui/tooltip";
import { breakable, fitName } from "./file-name";
import "./file-card.css";

const defaultWidth = 176;

/**
 * One file or Document as a card (DESIGN.md sections 7 and 10), with one
 * button that opens it. A 16:10 frame holds a labeled tile (the family glyph over
 * the extension) with the `still`, once there is one, fading in over it, so
 * nothing moves when it arrives. The name takes up to two lines and keeps its
 * end; the caption is the app's own type word and the size. `tooltip` is the full
 * name, shown only when there is something more to say.
 */
export function FileCard({
  name,
  tooltip,
  caption,
  glyph,
  label,
  still,
  onOpen,
  action,
  ref,
  width = defaultWidth,
}: {
  name: string;
  tooltip?: string | undefined;
  caption: ReactNode;
  glyph: ReactNode;
  /** The tile's word: the extension, or "DOC". */
  label: string;
  still?: ReactNode;
  onOpen: () => void;
  /** A reserved corner action, revealed on hover and focus. */
  action?: ReactNode;
  ref?: Ref<HTMLDivElement>;
  width?: number | undefined;
}) {
  const captionId = useId();
  const fitted = useMemo(
    () => fitName(name, undefined, width - 22),
    [name, width],
  );
  const nameLine = (
    <span
      className="file-card-name"
      data-measured={fitted.lines ? "" : undefined}
    >
      {fitted.lines
        ? fitted.lines.map((line, index) => <span key={index}>{line}</span>)
        : breakable(fitted.text)}
    </span>
  );
  const shown = tooltip ?? (fitted.cut ? name : undefined);
  return (
    <div
      ref={ref}
      className="file-card"
      data-action={action ? "" : undefined}
      style={{ "--file-card-width": width } as CSSProperties}
    >
      <button
        type="button"
        className="file-card-open"
        aria-label={name}
        aria-describedby={captionId}
        onClick={onOpen}
      >
        <span className="file-card-frame">
          <span className="file-card-tile" aria-hidden="true">
            {glyph}
            <span className="file-card-label">{label}</span>
          </span>
          {still}
        </span>
        <span className="file-card-band">
          <Tooltip content={shown}>{nameLine}</Tooltip>
          <small id={captionId} className="file-card-caption">
            {caption}
          </small>
        </span>
      </button>
      {action && <span className="file-card-action">{action}</span>}
    </div>
  );
}
