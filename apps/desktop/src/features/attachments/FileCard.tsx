import {
  Children,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { Tooltip } from "@/components/ui/tooltip";
import { breakable, fitName } from "./file-name";
import "./file-card.css";

/** The grid folds after this many cards, behind one "+N" card. */
const FOLD = 6;

/**
 * One file or Document as a card (DESIGN.md section 10): always 176px wide, one
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
}) {
  const captionId = useId();
  const fitted = fitName(name);
  const nameLine = (
    <span className="file-card-name">{breakable(fitted.text)}</span>
  );
  const shown = tooltip ?? (fitted.cut ? name : undefined);
  return (
    <div ref={ref} className="file-card" data-action={action ? "" : undefined}>
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

/**
 * The cards of one place in a wrapping grid, 176px a column with 12px gaps: a
 * narrow pane gets fewer columns, never bigger cards. More than six fold into
 * a "+N" card that opens the rest in place.
 */
export function FileGrid({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const items = Children.toArray(children);
  const [all, setAll] = useState(false);
  const list = useRef<HTMLUListElement>(null);
  const folded = !all && items.length > FOLD;
  const shown = folded ? items.slice(0, FOLD) : items;
  useEffect(() => {
    // The "+N" card is gone: land on the first card it revealed.
    if (all)
      list.current
        ?.querySelector<HTMLElement>(`li:nth-child(${FOLD + 1}) button`)
        ?.focus();
  }, [all]);
  return (
    <ul ref={list} className="file-grid" aria-label={label}>
      {shown}
      {folded && (
        <li className="file-card-item">
          <div className="file-card">
            <button
              type="button"
              className="file-card-open"
              onClick={() => setAll(true)}
            >
              <span className="file-card-frame">
                <span className="file-card-tile">
                  <span className="file-card-more">+{items.length - FOLD}</span>
                </span>
              </span>
              <span className="file-card-band">
                <span className="file-card-name">
                  Show all {items.length} files
                </span>
                <small className="file-card-caption">
                  {items.length} files in all
                </small>
              </span>
            </button>
          </div>
        </li>
      )}
    </ul>
  );
}
