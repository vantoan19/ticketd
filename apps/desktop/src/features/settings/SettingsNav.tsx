import { StatusDot } from "@/components/ui/status-dot";
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
export function SettingsNav({
  onBack,
  selected = "appearance",
  onSelect,
}: {
  onBack: () => void;
  selected?: SettingsCardKey;
  onSelect?: (section: SettingsCardKey) => void;
}) {
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
                      aria-current={
                        selected === section.id ? "page" : undefined
                      }
                      onClick={(event) => {
                        onSelect?.(section.id);
                        const keyboard = event.detail === 0;
                        requestAnimationFrame(() => {
                          if (
                            section.id.startsWith("source-") ||
                            section.id === "sync"
                          ) {
                            const heading =
                              document.getElementById("settings-heading");
                            const page = heading?.closest(".settings-page");
                            if (page) page.scrollTop = 0;
                            if (keyboard)
                              heading?.focus({ preventScroll: true });
                            return;
                          }
                          const card = document.getElementById(
                            settingsCardId(section.id),
                          );
                          card?.scrollIntoView?.({ block: "start" });
                          if (keyboard) card?.focus({ preventScroll: true });
                        });
                      }}
                    >
                      {section.label}
                      {entries.some(
                        (entry) =>
                          `source-${entry.connector.provider}` === section.id &&
                          entry.saved,
                      ) && (
                        <span className="settings-source-on">
                          <StatusDot tone="positive" size={8} />
                          On
                        </span>
                      )}
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
