import { useState } from "react";
import { SearchX } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { KeyChords } from "@/components/ui/kbd";
import { SearchInput } from "@/components/ui/search-input";
import { emptyCopy } from "@/lib/empty-copy";
import {
  SCOPE_CAPTIONS,
  SHORTCUTS,
  SHORTCUT_SCOPES,
  requiresChat,
  spokenKeys,
  type Shortcut,
  type ShortcutScope,
} from "@/lib/shortcuts";
import { sectionMeta } from "@/features/settings/settings-sections";
import { SettingsPage } from "@/features/settings/layout/SettingsPage";
import { SettingsSection } from "@/features/settings/layout/SettingsSection";
import {
  SettingsList,
  SettingsRow,
} from "@/features/settings/layout/SettingsList";
import { useChatFeature } from "@/features/chats/use-chats";
import "@/features/settings/pages/shortcuts-page.css";

function matches(shortcut: Shortcut, query: string) {
  return [
    shortcut.label,
    shortcut.note ?? "",
    spokenKeys(shortcut.keys, undefined, shortcut.sequences),
    shortcut.scope,
  ]
    .join(" ")
    .toLowerCase()
    .includes(query);
}

/** Every key that works, from the one registry in `lib/shortcuts.ts`. */
export function KeyboardShortcutsPage() {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const { enabled: chatEnabled } = useChatFeature();
  const visible = SHORTCUT_SCOPES.map((scope: ShortcutScope) => ({
    scope,
    shortcuts: (SHORTCUTS as readonly Shortcut[]).filter(
      (item) =>
        item.scope === scope &&
        (chatEnabled || !requiresChat(item)) &&
        (!needle || matches(item, needle)),
    ),
  })).filter((group) => group.shortcuts.length > 0);
  const none = emptyCopy("settings-shortcuts-search", { query: query.trim() });
  return (
    <SettingsPage {...sectionMeta("keyboard-shortcuts")}>
      <div className="shortcut-filter">
        <SearchInput
          size="default"
          fill
          aria-label="Filter shortcuts"
          placeholder="Search shortcuts…"
          value={query}
          onValueChange={setQuery}
        />
      </div>
      {visible.map((group) => (
        <SettingsSection
          key={group.scope}
          title={group.scope}
          caption={SCOPE_CAPTIONS[group.scope]}
        >
          <SettingsList>
            {group.shortcuts.map((item) => (
              <SettingsRow
                key={item.id}
                tight
                title={item.label}
                {...(item.note ? { description: item.note } : {})}
                trailing={
                  <span className="shortcut-keys">
                    <KeyChords keys={item.keys} sequences={item.sequences} />
                  </span>
                }
              />
            ))}
          </SettingsList>
        </SettingsSection>
      ))}
      {visible.length === 0 && (
        <div className="shortcut-none">
          <EmptyState
            role="status"
            icon={<SearchX />}
            title={none.title}
            description={none.sentence}
            action={
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setQuery("")}
              >
                Clear search
              </Button>
            }
          />
        </div>
      )}
    </SettingsPage>
  );
}
