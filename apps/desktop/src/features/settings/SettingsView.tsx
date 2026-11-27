import type { ProjectSourceSetup } from "@/features/projects/ConnectProjectSource";
import { modifierKeyLabel } from "@/lib/platform";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  SEARCH_INPUT_ID,
  agentPageId,
  resolveSettingsPage,
  type LegacySettingsPageId,
  type SettingsPageId,
} from "@/features/settings/settings-sections";
import { useSources } from "@/features/settings/sources/use-sources";
import type { SourceEntry } from "@/lib/api/sources";
import { AboutPage } from "@/features/settings/pages/AboutPage";
import { AgentPage } from "@/features/settings/pages/AgentPage";
import { AgentsPage } from "@/features/settings/pages/AgentsPage";
import { AgentSkillsPage } from "@/features/settings/pages/AgentSkillsPage";
import { AppearancePage } from "@/features/settings/pages/AppearancePage";
import { AttentionPage } from "@/features/settings/pages/AttentionPage";
import { AutomationsPage } from "@/features/settings/pages/AutomationsPage";
import { BackupsExportPage } from "@/features/settings/pages/BackupsExportPage";
import { CommandLinePage } from "@/features/settings/pages/CommandLinePage";
import { DiagnosticsPage } from "@/features/settings/pages/DiagnosticsPage";
import { FilesPage } from "@/features/settings/pages/FilesPage";
import { WorkspaceSyncPage } from "@/features/settings/pages/WorkspaceSyncPage";
import { KeyboardShortcutsPage } from "@/features/settings/pages/KeyboardShortcutsPage";
import { SearchPage } from "@/features/settings/pages/SearchPage";
import { SetupPage } from "@/features/settings/pages/SetupPage";
import { SourcePage } from "@/features/settings/pages/SourcePage";
import { SourcesPage } from "@/features/settings/pages/SourcesPage";
import { useFadeThrough } from "@/features/settings/fade-through";
import { showSetting } from "@/features/settings/settings-highlight";
import { useSettingsState } from "@/features/settings/use-settings-state";
import { useIsMobile } from "@/hooks/use-mobile";
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
  onWorkspaceReplaced,
  onSourcesChanged,
  onSelect,
  onOpenAutomations,
  projectSourceSetup,
  onProjectSourceSaved,
  onProjectSourceCancel,
  onProjectLinked,
  selected: chosenName = "appearance",
}: {
  /** The open page, under its current or an old name (`resolveSettingsPage`). */
  selected?: SettingsPageId | LegacySettingsPageId;
  /** Opens another page, for links between pages and for ⌘F. */
  onSelect?: (page: SettingsPageId) => void;
  /** Leaves Settings for the Automations view. */
  onOpenAutomations?: () => void;
  /** Called after anything replaced the Workspace: a restore, or a download from Drive. */
  onRestore: () => Promise<void>;
  /** Called as soon as the replacement succeeds, before refreshing views. */
  onWorkspaceReplaced?: (() => void) | undefined;
  onSourcesChanged?: (added?: SourceEntry) => Promise<void>;
  projectSourceSetup?: ProjectSourceSetup;
  onProjectSourceSaved?: (connection: string) => void;
  onProjectSourceCancel?: () => void;
  onProjectLinked?: (projectId: string, connection: string) => void;
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
  const chosen = resolveSettingsPage(chosenName);
  // Choosing another page fades the open one out, then the next arrives.
  const { shown: selected, leaving } = useFadeThrough(chosen);
  // Every page shares one scroll container, so a page would otherwise open at
  // the scroll offset the previous one was left at. Before paint: no jump.
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
  }, [selected]);
  // A result of Search opens its page and shows the setting there. The page
  // is `selected` once the old one has faded out. Going elsewhere first drops
  // the request, so it never fires on a later visit.
  const { target, clearTarget, setNavOpen } = useSettingsState();
  const shownSetting = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (target && target.page !== chosen) clearTarget?.();
  }, [target, chosen, clearTarget]);
  useEffect(() => {
    if (!target || target.page !== selected || !scroller.current) return;
    shownSetting.current?.();
    shownSetting.current = showSetting(scroller.current, target.title);
    clearTarget?.();
  }, [target, selected, clearTarget]);
  useEffect(() => () => shownSetting.current?.(), []);
  // ⌘F and Ctrl+F search the settings, not the page, while Settings is open.
  // On a narrow window the field is in the nav sheet, which is closed: open it,
  // then focus the field once the sheet has mounted it.
  const mobile = useIsMobile();
  const focusing = useRef(0);
  useEffect(() => () => cancelAnimationFrame(focusing.current), []);
  useEffect(() => {
    function focusField(framesLeft: number) {
      const field = document.getElementById(SEARCH_INPUT_ID);
      if (field) {
        field.focus();
        if (field instanceof HTMLInputElement) field.select();
      } else if (framesLeft > 0) {
        focusing.current = requestAnimationFrame(() =>
          focusField(framesLeft - 1),
        );
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (!isFindShortcut(event)) return;
      event.preventDefault();
      onSelect?.("search");
      if (mobile && !document.getElementById(SEARCH_INPUT_ID))
        setNavOpen?.(true);
      cancelAnimationFrame(focusing.current);
      focusField(mobile ? 20 : 0);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onSelect, mobile, setNavOpen]);
  return (
    <div
      ref={scroller}
      className="settings-page"
      data-own-entrance=""
      data-leaving={leaving || undefined}
      // Fading out, the page is out of reach: nothing in it takes focus or a click.
      inert={leaving || undefined}
    >
      {selected === "setup" && <SetupPage />}
      {selected === "appearance" && <AppearancePage />}
      {selected === "attention" && <AttentionPage />}
      {selected === "files" && <FilesPage key={restores} />}
      {selected === "backups-export" && (
        <BackupsExportPage
          onRestore={replaced}
          onWorkspaceReplaced={onWorkspaceReplaced}
          onOpenSync={() => onSelect?.("workspace-sync")}
        />
      )}
      {selected === "command-line" && <CommandLinePage />}
      {selected === "agent-skills" && <AgentSkillsPage />}
      {selected === "agents" && (
        <AgentsPage onOpen={(id) => onSelect?.(agentPageId(id))} />
      )}
      {selected.startsWith("agent:") && (
        <AgentPage
          id={selected.slice("agent:".length)}
          onBack={() => onSelect?.("agents")}
        />
      )}
      {selected === "automations" && (
        <AutomationsPage onOpenAutomations={() => onOpenAutomations?.()} />
      )}
      {selected === "workspace-sync" && (
        <WorkspaceSyncPage
          onReplaced={() => {
            onWorkspaceReplaced?.();
            return replaced();
          }}
        />
      )}
      {selected === "keyboard-shortcuts" && <KeyboardShortcutsPage />}
      {selected === "diagnostics" && <DiagnosticsPage />}
      {selected === "about" && <AboutPage />}
      {selected === "search" && <SearchPage />}
      {selected === "ticket-sources" && (
        <SourcesPage
          onOpen={(id) => onSelect?.(`source-${id}`)}
          onChanged={onSourcesChanged}
          {...(projectSourceSetup &&
            onProjectSourceSaved &&
            onProjectSourceCancel && {
              projectSetup: {
                setup: projectSourceSetup,
                onSaved: onProjectSourceSaved,
                onCancel: onProjectSourceCancel,
              },
            })}
        />
      )}
      {sources.map((entry) => (
        <SourcePage
          key={`${restores}:${entry.saved?.id ?? entry.connector.provider}`}
          entry={entry}
          active={
            selected === `source-${entry.saved?.id ?? entry.connector.provider}`
          }
          onBack={() => onSelect?.("ticket-sources")}
          {...(onSourcesChanged && {
            onChanged: (added?: SourceEntry) => onSourcesChanged(added),
          })}
          onOpen={(id) => onSelect?.(`source-${id}`)}
          {...(onProjectLinked && { onProjectLinked })}
        />
      ))}
    </div>
  );
}
