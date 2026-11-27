import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "cn";
import { IconTile } from "@/components/ui/icon-tile";

/** A surface of rows divided by hairlines, with an optional `SettingsListFooter`. */
export function SettingsList({
  children,
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div className={cn("settings-list", className)} {...props}>
      {children}
    </div>
  );
}

/**
 * One row: an optional leading tile, a title (14/500) with a description
 * (12/16 muted), and a trailing control. At least 64px tall.
 * - `center` (default) aligns the slots on the middle.
 * - `top` aligns them on the first line, for switches and wrapping text.
 * - `stacked` puts `children`, a full-width control, under the text.
 *
 * `onOpen` makes the row open something in place: a chevron ends it, and a
 * click anywhere on the row that is not itself a control opens it too. The
 * chevron is the keyboard stop, named by `openLabel`, so a control inside the
 * row (a switch, Copy command) is never nested in another button.
 */
export function SettingsRow({
  leading,
  title,
  description,
  titleId,
  descriptionId,
  trailing,
  variant = "center",
  role,
  tight = false,
  onOpen,
  openLabel,
  children,
}: {
  leading?: ReactNode;
  title?: ReactNode;
  description?: ReactNode;
  /** Lets a control name itself by the title with `aria-labelledby`. */
  titleId?: string;
  descriptionId?: string;
  trailing?: ReactNode;
  variant?: "center" | "top" | "stacked";
  /** `listitem` when the parent `SettingsList` is a labelled `role="list"`. */
  role?: "listitem";
  /** A 48px row for short one-line items such as a shortcut. */
  tight?: boolean;
  /** Opens what the row stands for, in place. Needs `openLabel`. */
  onOpen?: () => void;
  /** Names the chevron: "Open Claude Code". */
  openLabel?: string;
  /** Content under the text; with `stacked` it spans the row. */
  children?: ReactNode;
}) {
  return (
    <div
      className="settings-list-row"
      data-variant={variant}
      data-tight={tight || undefined}
      data-openable={onOpen ? "" : undefined}
      role={role}
      {...(onOpen && {
        onClick: (event: React.MouseEvent<HTMLElement>) => {
          const target = event.target as Element;
          if (
            !target.closest(
              "button, a, input, select, textarea, label, summary, [role='switch'], [contenteditable]",
            )
          )
            onOpen();
        },
      })}
    >
      {leading}
      <div className="settings-list-row-main">
        {/* Divs, not paragraphs: a title or description may hold a block, such
            as a loading skeleton, and a block cannot sit inside a <p>. */}
        {title && (
          <div className="settings-list-row-title" id={titleId}>
            {title}
          </div>
        )}
        {description && (
          <div className="settings-list-row-description" id={descriptionId}>
            {description}
          </div>
        )}
        {children}
      </div>
      {(trailing || onOpen) && (
        <div className="settings-list-row-trailing">
          {trailing}
          {onOpen && (
            <button
              type="button"
              className="settings-row-open"
              aria-label={openLabel}
              onClick={onOpen}
            >
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** A row's leading icon: the shared IconTile. In a list every row has one or none does. */
export function SettingsRowTile({ children }: { children: ReactNode }) {
  return <IconTile>{children}</IconTile>;
}

/** A recessed strip at the foot of a list: status text, with actions at the end. */
export function SettingsListFooter({
  children,
  actions,
}: {
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="settings-list-footer">
      <div className="settings-list-footer-text">{children}</div>
      {actions && <div className="settings-list-footer-actions">{actions}</div>}
    </div>
  );
}
