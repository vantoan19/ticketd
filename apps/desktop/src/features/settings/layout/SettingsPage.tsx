import { useEffect, useRef, type ReactNode } from "react";
import { Check, type LucideIcon } from "lucide-react";
import "@/features/settings/layout/settings-layout.css";

/**
 * One Settings page: the sticky panel bar with its breadcrumb, then a centred
 * column with the page header. The title is the page's `h1` and takes focus
 * when the page opens. Pages put `SettingsSection`s in the column.
 */
export function SettingsPage({
  group,
  label,
  icon: Icon,
  title = label,
  lede,
  endSlot,
  titleAccessory,
  hidden = false,
  focusTitle = true,
  children,
}: {
  /** Breadcrumb group, muted: "Workspace". */
  group: string;
  /** Breadcrumb page name, in the foreground color. */
  label: string;
  icon: LucideIcon;
  /** The `h1`; the label unless the page names itself differently. */
  title?: ReactNode;
  /** One sentence under the title, at most 560px wide. */
  lede?: ReactNode;
  /** The end of the panel bar: `<AppliesRightAway />` or a source's save state. */
  endSlot?: ReactNode;
  /** Sits beside the title, such as Chat's Experimental badge. */
  titleAccessory?: ReactNode;
  /** Keeps the page mounted but out of sight (a source's draft and preview). */
  hidden?: boolean;
  /** Pages with a better first control, such as Search, take focus themselves. */
  focusTitle?: boolean;
  children: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  // Opening a page replaces what held focus; land on its title.
  useEffect(() => {
    if (!hidden && focusTitle) heading.current?.focus({ preventScroll: true });
  }, [hidden, focusTitle]);
  return (
    <div className="settings-shell" hidden={hidden}>
      <div className="settings-panel-bar">
        <nav aria-label="Breadcrumb">
          <ol>
            <li>{group}</li>
            <li aria-current="page">{label}</li>
          </ol>
        </nav>
        {endSlot && <div className="settings-panel-bar-end">{endSlot}</div>}
      </div>
      <div className="settings-page-column">
        <header className="settings-page-header">
          <span className="settings-page-icon" aria-hidden="true">
            <Icon size={20} />
          </span>
          <div className="settings-page-heading">
            <div className="settings-page-title-line">
              <h1 ref={heading} tabIndex={-1}>
                {title}
              </h1>
              {titleAccessory}
            </div>
            {lede && <p className="settings-page-lede">{lede}</p>}
          </div>
        </header>
        {children}
      </div>
    </div>
  );
}

/** The panel bar's end slot on pages whose controls take effect when changed. */
export function AppliesRightAway() {
  return (
    <span className="settings-applies">
      <Check size={14} aria-hidden="true" />
      Changes apply right away
    </span>
  );
}
