import type { ReactNode } from "react";
import { cn } from "cn";

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
  /** Content under the text; with `stacked` it spans the row. */
  children?: ReactNode;
}) {
  return (
    <div
      className="settings-list-row"
      data-variant={variant}
      data-tight={tight || undefined}
      role={role}
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
      {trailing && <div className="settings-list-row-trailing">{trailing}</div>}
    </div>
  );
}

/** A square tile for a row's leading icon (recessed fill, border ring). */
export function SettingsRowTile({ children }: { children: ReactNode }) {
  return (
    <span className="settings-list-row-tile" aria-hidden="true">
      {children}
    </span>
  );
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
