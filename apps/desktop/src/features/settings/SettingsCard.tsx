import type { ReactNode } from "react";
import {
  settingsCardId,
  type SettingsCardKey,
} from "@/features/settings/settings-sections";

/** One titled card on the Settings page, reachable from the section list. */
export function SettingsCard({
  id,
  title,
  actions,
  children,
}: {
  id: SettingsCardKey;
  title: string;
  /** Controls beside the title, such as Edit. */
  actions?: ReactNode;
  children: ReactNode;
}) {
  const headingId = `${settingsCardId(id)}-heading`;
  return (
    <section
      id={settingsCardId(id)}
      className="settings-card"
      aria-labelledby={headingId}
      tabIndex={-1}
    >
      {actions ? (
        <div className="settings-card-header">
          <h2 id={headingId}>{title}</h2>
          {actions}
        </div>
      ) : (
        <h2 id={headingId}>{title}</h2>
      )}
      {children}
    </section>
  );
}
