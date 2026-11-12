import { ArrowLeft, Search, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Kbd } from "@/components/ui/kbd";
import { StatusDot } from "@/components/ui/status-dot";
import { modifierKeyLabel } from "@/lib/platform";
import {
  SETTINGS_GROUPS,
  SETTINGS_SECTIONS,
  sourceSection,
  type SettingsGroup,
  type SettingsPageId,
} from "@/features/settings/settings-sections";
import { useSettingsState } from "@/features/settings/use-settings-state";
import { useSources } from "@/features/settings/sources/use-sources";
import "@/features/settings/settings.css";

interface NavItem {
  id: SettingsPageId;
  label: string;
  group: SettingsGroup;
  icon: LucideIcon;
}

/** Takes the workspace sidebar's place while Settings is open. */
export function SettingsNav({
  onBack,
  selected = "appearance",
  onSelect,
}: {
  onBack: () => void;
  selected?: SettingsPageId;
  onSelect?: (page: SettingsPageId) => void;
}) {
  const { entries } = useSources();
  const { query, needsSetup } = useSettingsState();
  const items: NavItem[] = [
    ...SETTINGS_SECTIONS,
    ...entries.map(({ connector }) =>
      sourceSection(connector.provider, connector.name),
    ),
  ];
  const indicator = (item: NavItem) => {
    if (
      (item.id === "command-line" || item.id === "agent-skills") &&
      needsSetup[item.id]
    )
      return { label: "Needs setup", tone: "attention" as const };
    if (
      entries.some(
        (entry) =>
          `source-${entry.connector.provider}` === item.id && entry.saved,
      )
    )
      return { label: "On", tone: "positive" as const };
    return null;
  };
  const modifier = modifierKeyLabel();
  const findHint = modifier === "Ctrl" ? "Ctrl+F" : `${modifier}F`;
  const shown = query.trim();
  return (
    <aside className="settings-nav" aria-label="Settings">
      <button type="button" className="settings-back" onClick={onBack}>
        <ArrowLeft size={16} aria-hidden="true" /> Back to tickets
      </button>
      <button
        type="button"
        className="settings-search-entry"
        aria-current={selected === "search" ? "page" : undefined}
        onClick={() => onSelect?.("search")}
      >
        <Search size={16} aria-hidden="true" />
        <span className="settings-nav-label">{shown || "Search settings"}</span>
        <Kbd aria-hidden="true">{findHint}</Kbd>
      </button>
      <nav aria-label="Settings sections">
        {SETTINGS_GROUPS.map((group) => {
          const sections = items.filter((item) => item.group === group);
          if (sections.length === 0) return null;
          return (
            <div key={group} role="group" aria-label={group}>
              <p className="settings-nav-heading" aria-hidden="true">
                {group}
              </p>
              <ul>
                {sections.map((item) => {
                  const dot = indicator(item);
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        aria-current={selected === item.id ? "page" : undefined}
                        onClick={() => onSelect?.(item.id)}
                      >
                        <item.icon size={16} aria-hidden="true" />
                        <span className="settings-nav-label">{item.label}</span>
                        {item.id === "chat" && (
                          <Badge size="sm">Experimental</Badge>
                        )}
                        {dot && (
                          <span
                            role="img"
                            aria-label={dot.label}
                            title={dot.label}
                            className="settings-nav-dot"
                          >
                            <StatusDot tone={dot.tone} />
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>
    </aside>
  );
}
