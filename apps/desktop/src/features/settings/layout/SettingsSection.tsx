import { useId, type ReactNode } from "react";
import { SectionHeader } from "@/components/ui/section-header";

/**
 * A titled group on a Settings page: a level 2 heading row with an optional
 * caption and actions (Check again, Refresh now, a status label), then the
 * content, usually a `SettingsList`. Sections sit 32px apart.
 */
export function SettingsSection({
  title,
  caption,
  actions,
  children,
}: {
  title: string;
  /** A muted line under the title, at most 520px wide. */
  caption?: ReactNode;
  /** Controls at the end of the heading row. */
  actions?: ReactNode;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <section className="settings-section" aria-labelledby={titleId}>
      <SectionHeader
        level={2}
        titleId={titleId}
        title={title}
        caption={caption}
        actions={actions}
      />
      {children}
    </section>
  );
}
