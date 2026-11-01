import { ArrowLeft } from "lucide-react";
import {
  SETTINGS_GROUPS,
  SETTINGS_SECTIONS,
  settingsCardId,
  sourceSection,
  type SettingsCardKey,
  type SettingsGroup,
} from "@/features/settings/settings-sections";
import { useSources } from "@/features/settings/sources/use-sources";
import "@/features/settings/settings.css";

/** Takes the workspace sidebar's place while Settings is open. */
export function SettingsNav({ onBack }: { onBack: () => void }) {
  const { entries } = useSources();
  const allSections: {
    id: SettingsCardKey;
    label: string;
    group: SettingsGroup;
  }[] = [
    ...SETTINGS_SECTIONS,
    ...entries.map(({ connector }) =>
      sourceSection(connector.provider, connector.name),
    ),
  ];
  return (
    <aside className="settings-nav" aria-label="Settings">
      <button type="button" className="settings-back" onClick={onBack}>
        <ArrowLeft size={16} /> Back to tickets
      </button>
      <nav aria-label="Settings sections">
        {SETTINGS_GROUPS.map((group) => {
          const sections = allSections.filter(
            (section) => section.group === group,
          );
          if (sections.length === 0) return null;
          return (
            <div key={group} role="group" aria-label={group}>
              <p className="settings-nav-heading" aria-hidden="true">
                {group}
              </p>
              <ul>
                {sections.map((section) => (
                  <li key={section.id}>
                    <button
                      type="button"
                      onClick={() => {
                        const card = document.getElementById(
                          settingsCardId(section.id),
                        );
                        card?.scrollIntoView?.({ block: "start" });
                        card?.focus({ preventScroll: true });
                      }}
                    >
                      {section.label}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </nav>
    </aside>
  );
}
