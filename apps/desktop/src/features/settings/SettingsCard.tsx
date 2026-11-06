import type { ReactNode } from "react";
import {
  settingsCardId,
  type SettingsCardKey,
} from "@/features/settings/settings-sections";

/** One titled card on the Settings page, reachable from the section list. */
export function SettingsCard({
  id,
  title,
  description,
  actions,
  children,
  footer,
}: {
  id: SettingsCardKey;
  title: string;
  /** A sentence under the title; with `actions` they sit at the top right. */
  description?: ReactNode;
  /** Controls beside the title, such as Edit. */
  actions?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const headingId = `${settingsCardId(id)}-heading`;
  return (
    <section
      id={settingsCardId(id)}
      className="settings-card"
      aria-labelledby={headingId}
      tabIndex={-1}
    >
      {description ? (
        <div className="settings-card-header" data-described>
          <div className="settings-card-heading">
            <h2 id={headingId}>{title}</h2>
            <p className="settings-card-description">{description}</p>
          </div>
          {actions}
        </div>
      ) : actions ? (
        <div className="settings-card-header">
          <h2 id={headingId}>{title}</h2>
          {actions}
        </div>
      ) : (
        <h2 id={headingId}>{title}</h2>
      )}
      {children}
      {footer && <div className="settings-card-footer">{footer}</div>}
    </section>
  );
}
