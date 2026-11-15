import { modifierKeyLabel } from "@/lib/platform";
import { useEffect, useState } from "react";
import type { SettingsPageId } from "@/features/settings/settings-sections";
import { useSources } from "@/features/settings/sources/use-sources";
import { AboutPage } from "@/features/settings/pages/AboutPage";
import { AgentSkillsPage } from "@/features/settings/pages/AgentSkillsPage";
import { AppearancePage } from "@/features/settings/pages/AppearancePage";
import { AttachmentsPage } from "@/features/settings/pages/AttachmentsPage";
import { AttentionPage } from "@/features/settings/pages/AttentionPage";
import { AutomationsPage } from "@/features/settings/pages/AutomationsPage";
import { BackupsPage } from "@/features/settings/pages/BackupsPage";
import { ChatPage } from "@/features/settings/pages/ChatPage";
import { CommandLinePage } from "@/features/settings/pages/CommandLinePage";
import { ExportPage } from "@/features/settings/pages/ExportPage";
import { GoogleDrivePage } from "@/features/settings/pages/GoogleDrivePage";
import { KeyboardShortcutsPage } from "@/features/settings/pages/KeyboardShortcutsPage";
import { LocationPage } from "@/features/settings/pages/LocationPage";
import {
  SEARCH_INPUT_ID,
  SearchPage,
} from "@/features/settings/pages/SearchPage";
import { SourcePage } from "@/features/settings/pages/SourcePage";
import "@/features/settings/settings.css";

/** True for the platform's find chord: ⌘F on macOS, Ctrl+F elsewhere. */
function isFindShortcut(event: KeyboardEvent) {
  const mac = modifierKeyLabel() === "⌘";
  return (
    (mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === "f"
  );
}

/**
 * The Settings content: the page for the selected section, one at a time.
 * Each page is its own file in `pages/` and renders inside `SettingsPage`.
 */
export function SettingsView({
  onRestore,
  onOpenInbox,
  onSelect,
  selected = "appearance",
}: {
  selected?: SettingsPageId;
  /** Opens another page, for links between pages and for ⌘F. */
  onSelect?: (page: SettingsPageId) => void;
  onRestore: () => Promise<void>;
  onOpenInbox: () => void;
}) {
  // The parent mounts this only while Settings is open, so every page reads
  // fresh data on each visit. A restore replaces the workspace under an open
  // page, so source pages (the only ones kept mounted) start over afterwards.
  const [restores, setRestores] = useState(0);
  const { entries: sources } = useSources();
  // ⌘F and Ctrl+F search the settings, not the page, while Settings is open.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!isFindShortcut(event)) return;
      event.preventDefault();
      onSelect?.("search");
      // Already on Search: the page does not remount, so focus its input here.
      document.getElementById(SEARCH_INPUT_ID)?.focus();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onSelect]);
  return (
    <div className="settings-page">
      {selected === "appearance" && <AppearancePage />}
      {selected === "attention" && <AttentionPage onOpenInbox={onOpenInbox} />}
      {selected === "location" && <LocationPage />}
      {selected === "attachments" && <AttachmentsPage key={restores} />}
      {selected === "backups" && (
        <BackupsPage
          onRestore={async () => {
            setRestores((count) => count + 1);
            await onRestore();
          }}
        />
      )}
      {selected === "export" && <ExportPage />}
      {selected === "command-line" && <CommandLinePage />}
      {selected === "agent-skills" && <AgentSkillsPage />}
      {selected === "chat" && <ChatPage />}
      {selected === "automations" && <AutomationsPage />}
      {selected === "google-drive" && <GoogleDrivePage />}
      {selected === "keyboard-shortcuts" && <KeyboardShortcutsPage />}
      {selected === "about" && <AboutPage />}
      {selected === "search" && <SearchPage />}
      {sources.map((entry) => (
        <SourcePage
          key={`${restores}:${entry.connector.provider}`}
          entry={entry}
          active={selected === `source-${entry.connector.provider}`}
        />
      ))}
    </div>
  );
}
