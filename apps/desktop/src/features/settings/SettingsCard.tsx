import type { ReactNode } from "react";
import {
  settingsCardId,
  type SettingsSectionId,
} from "@/features/settings/settings-sections";

export function SettingsCard({
  id,
  title,
  children,
}: {
  id: SettingsSectionId;
  title: string;
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
      <h2 id={headingId}>{title}</h2>
      {children}
    </section>
  );
}
