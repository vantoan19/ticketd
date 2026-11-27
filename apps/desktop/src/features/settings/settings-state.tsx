import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { agentSkillsClient, type AgentSkill } from "@/lib/api/agent-skills";
import { client, type AgentUpdate } from "@/lib/api/client";
import { cliClient, type CliStatus } from "@/lib/api/cli";
import { useNotificationPermission } from "@/lib/notification-permission";
import { setPreference, usePreferences } from "@/lib/preferences";
import { useOnWorkspaceChange } from "@/lib/workspace-change";
import { useSyncStatus } from "@/features/sync/sync-status";
import { useSources } from "@/features/settings/sources/use-sources";
import { deriveSetup } from "@/features/setup/setup-state";
import { useChatClient } from "@/features/chats/client";
import { agentChecksStore } from "@/features/settings/agent-checks";
import { useChatFeature } from "@/features/chats/use-chats";
import {
  chatNeedsSetup,
  cliNeedsSetup,
  skillsNeedSetup,
} from "@/features/settings/settings-indicators";

import { pageNeedingYou } from "@/features/settings/settings-needs";
import { useNeedsFrom } from "@/features/settings/use-needs";
import type {
  SettingsPageId,
  SettingsSectionId,
} from "@/features/settings/settings-sections";
import {
  SettingsStateContext,
  type IndicatorSection,
  type SettingsRead,
  type SettingsTarget,
} from "@/features/settings/use-settings-state";

/** Holds what the nav and the pages share while Settings is open. */
export function SettingsStateProvider({
  active = true,
  onOpenPage = () => {},
  needsPageRef,
  children,
}: {
  /** Opens a Settings page; the page that is open belongs to the parent. */
  onOpenPage?: (page: SettingsPageId) => void;
  /** False while Settings is closed; indicators are read at startup and on each open. */
  active?: boolean;
  /**
   * Kept up to date with the first page that needs the person, which the app
   * reads when Settings opens (`initialSettingsPage`).
   */
  needsPageRef?: RefObject<SettingsSectionId | null>;
  children: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [navOpen, setNavOpen] = useState(false);
  const [target, setTarget] = useState<SettingsTarget | null>(null);
  const targets = useRef(0);
  const openSetting = useCallback(
    (page: SettingsPageId, title: string) => {
      targets.current += 1;
      setTarget({ page, title, id: targets.current });
      onOpenPage(page);
    },
    [onOpenPage],
  );
  const clearTarget = useCallback(() => setTarget(null), []);
  const [needsSetup, setNeedsSetup] = useState<
    Partial<Record<IndicatorSection, boolean>>
  >({});
  // What Set up ticketd ticks from. The command line and the skills are the
  // same readings as the nav dots; the first agent update is read apart.
  const [cli, setCli] = useState<CliStatus | null>(null);
  const [skills, setSkills] = useState<AgentSkill[] | null>(null);
  const [agentUpdate, setAgentUpdate] = useState<
    AgentUpdate | null | undefined
  >(undefined);
  // The newest reading of each wins: the native checks answer in any order.
  const latest = useRef({ cli: 0, skills: 0 });
  const chats = useChatClient();
  const { enabled: chatEnabled } = useChatFeature();
  const refreshIndicators = useCallback(
    (section?: SettingsRead, options?: { refreshPath?: boolean }) => {
      const set = (key: IndicatorSection, value: boolean | undefined) =>
        setNeedsSetup((current) => {
          const next = { ...current };
          if (value === undefined) delete next[key];
          else next[key] = value;
          return next;
        });
      const reads = (key: SettingsRead) =>
        section === undefined || section === key;
      if (reads("command-line")) {
        const mine = ++latest.current.cli;
        void cliClient.check(options?.refreshPath).then(
          (status) => {
            if (mine !== latest.current.cli) return;
            setCli(status);
            set("command-line", cliNeedsSetup(status));
          },
          () => {
            if (mine !== latest.current.cli) return;
            setCli(null);
            set("command-line", undefined);
          },
        );
      }
      if (reads("agent-skills")) {
        const mine = ++latest.current.skills;
        void agentSkillsClient.list().then(
          (agents) => {
            if (mine !== latest.current.skills) return;
            setSkills(agents);
            set("agent-skills", skillsNeedSetup(agents));
          },
          () => {
            if (mine !== latest.current.skills) return;
            setSkills(null);
            set("agent-skills", undefined);
          },
        );
      }
      if (reads("agent-update"))
        void (async () => {
          try {
            setAgentUpdate(await client.firstAgentUpdate());
          } catch {
            // Unread: the step stays unticked and the next reading tries again.
          }
        })();
      // The agents matter only while Chats are shown; the check itself is
      // the one the Agents page reads (`agentChecksStore`), and the dot
      // follows its answer below.
      if (reads("agents")) {
        if (!chatEnabled) set("agents", undefined);
        else void agentChecksStore(chats).refresh();
      }
    },
    [chats, chatEnabled],
  );
  // The dot follows every answer to the agents' check, whoever asked: the
  // sidebar at startup, the page's Check again, or the window regaining focus.
  useEffect(() => {
    const store = agentChecksStore(chats);
    const follow = () => {
      const checks = store.getSnapshot();
      setNeedsSetup((current) => {
        const next = { ...current };
        if (
          !chatEnabled ||
          checks.phase === "idle" ||
          checks.phase === "failed"
        )
          delete next.agents;
        else if (checks.phase === "done")
          next.agents = chatNeedsSetup([...checks.harnesses]);
        return next;
      });
    };
    follow();
    return store.subscribe(follow);
  }, [chats, chatEnabled]);
  // Read once at startup, so the nav shows its dots on Settings' first frame
  // instead of popping them in, then again each time Settings opens. A reading
  // keeps the last result until the new one arrives. Pages refresh after they
  // change something.
  const read = useRef(false);
  useEffect(() => {
    if (!active && read.current) return;
    read.current = true;
    refreshIndicators();
  }, [active, refreshIndicators]);
  // An agent that writes an update changes the Workspace: look again for the
  // first one until it is found. A person who runs one in a terminal and comes
  // back also changed the command line and the skills.
  useOnWorkspaceChange(
    () => refreshIndicators("agent-update"),
    agentUpdate === null,
  );
  useEffect(() => {
    if (!active) return;
    const onFocus = () => {
      refreshIndicators("command-line");
      refreshIndicators("agent-skills");
      refreshIndicators("agent-update");
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [active, refreshIndicators]);

  const sources = useSources();
  const { status: sync } = useSyncStatus();
  const notifications = useNotificationPermission();
  const setup = useMemo(
    () =>
      deriveSetup({
        cli,
        skills,
        agentUpdate,
        sources: sources.loading ? null : sources.entries,
        sync,
        notifications,
      }),
    [
      cli,
      skills,
      agentUpdate,
      sources.loading,
      sources.entries,
      sync,
      notifications,
    ],
  );
  const firstNeed = pageNeedingYou(useNeedsFrom(needsSetup));
  useEffect(() => {
    if (needsPageRef) needsPageRef.current = firstNeed;
  }, [needsPageRef, firstNeed]);
  // Once every step has been ticked, the checklist is finished for good.
  const { setupHidden, setupFinished } = usePreferences();
  useEffect(() => {
    if (setup.complete && !setupFinished) setPreference("setupFinished", true);
  }, [setup.complete, setupFinished]);
  // The row leaves the sidebar when Settings is closed after finishing, not
  // under the person's eyes: whether it was finished or hidden is read as Settings opens.
  const [wasActive, setWasActive] = useState(active);
  const [finishedOnOpen, setFinishedOnOpen] = useState(setupFinished);
  const [hiddenOnOpen, setHiddenOnOpen] = useState(setupHidden);
  if (active !== wasActive) {
    setWasActive(active);
    if (active) {
      setFinishedOnOpen(setupFinished);
      setHiddenOnOpen(setupHidden);
    }
  }
  // Hiding it works the same way: the sidebar does not jump under the person.
  const setupRow = !hiddenOnOpen && !finishedOnOpen;
  const hideSetup = useCallback(() => setPreference("setupHidden", true), []);

  const value = useMemo(
    () => ({
      query,
      setQuery,
      openPage: onOpenPage,
      openSetting,
      target,
      clearTarget,
      needsSetup,
      refreshIndicators,
      setup,
      setupRow,
      hideSetup,
      navOpen,
      setNavOpen,
    }),
    [
      query,
      onOpenPage,
      openSetting,
      target,
      clearTarget,
      needsSetup,
      refreshIndicators,
      setup,
      setupRow,
      hideSetup,
      navOpen,
    ],
  );
  return (
    <SettingsStateContext.Provider value={value}>
      {children}
    </SettingsStateContext.Provider>
  );
}
