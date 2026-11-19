import { modifierKeyLabel } from "@/lib/platform";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
import { DiagnosticsPage } from "@/features/settings/pages/DiagnosticsPage";
import { ExportPage } from "@/features/settings/pages/ExportPage";
import { GoogleDrivePage } from "@/features/settings/pages/GoogleDrivePage";
import { KeyboardShortcutsPage } from "@/features/settings/pages/KeyboardShortcutsPage";
import { LocationPage } from "@/features/settings/pages/LocationPage";
import {
  SEARCH_INPUT_ID,
  SearchPage,
} from "@/features/settings/pages/SearchPage";
import { SourcePage } from "@/features/settings/pages/SourcePage";
import { useFadeThrough } from "@/features/settings/fade-through";
// The keyframes of the page's own entrance (settings-layout.css plays them).
import "@/components/ui/enter";
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
  selected: chosen = "appearance",
}: {
  selected?: SettingsPageId;
  /** Opens another page, for links between pages and for ⌘F. */
  onSelect?: (page: SettingsPageId) => void;
  /** Called after anything replaced the Workspace: a restore, or a download from Drive. */
  onRestore: () => Promise<void>;
  onOpenInbox: () => void;
}) {
  // The parent mounts this only while Settings is open, so every page reads
  // fresh data on each visit. A restore or a download replaces the workspace
  // under an open page, so source pages (the only ones kept mounted) start over
  // afterwards.
  const [restores, setRestores] = useState(0);
  const replaced = async () => {
    setRestores((count) => count + 1);
    await onRestore();
  };
  const { entries: sources } = useSources();
  // Choosing another page fades the open one out, then the next arrives.
  const { shown: selected, leaving } = useFadeThrough(chosen);
  // Every page shares one scroll container, so a page would otherwise open at
  // the scroll offset the previous one was left at. Before paint: no jump.
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
  }, [selected]);
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
    <div
      ref={scroller}
      className="settings-page"
      data-own-entrance=""
      data-leaving={leaving || undefined}
      // Fading out, the page is out of reach: nothing in it takes focus or a click.
      inert={leaving || undefined}
    >
      {selected === "appearance" && <AppearancePage />}
      {selected === "attention" && <AttentionPage onOpenInbox={onOpenInbox} />}
      {selected === "location" && <LocationPage />}
      {selected === "attachments" && <AttachmentsPage key={restores} />}
      {selected === "backups" && <BackupsPage onRestore={replaced} />}
      {selected === "export" && <ExportPage />}
      {selected === "command-line" && <CommandLinePage />}
      {selected === "agent-skills" && <AgentSkillsPage />}
      {selected === "chat" && <ChatPage />}
      {selected === "automations" && <AutomationsPage />}
      {selected === "google-drive" && <GoogleDrivePage onReplaced={replaced} />}
      {selected === "keyboard-shortcuts" && <KeyboardShortcutsPage />}
      {selected === "diagnostics" && <DiagnosticsPage />}
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
