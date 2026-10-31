import { ArrowLeft } from "lucide-react";
import {
  SETTINGS_GROUPS,
  SETTINGS_SECTIONS,
  settingsCardId,
} from "@/features/settings/settings-sections";
import "@/features/settings/settings.css";

/** Takes the workspace sidebar's place while Settings is open. */
export function SettingsNav({ onBack }: { onBack: () => void }) {
  return (
    <aside className="settings-nav" aria-label="Settings">
      <button type="button" className="settings-back" onClick={onBack}>
        <ArrowLeft size={16} /> Back to tickets
      </button>
      <nav aria-label="Settings sections">
        {SETTINGS_GROUPS.map((group) => {
          const sections = SETTINGS_SECTIONS.filter(
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
