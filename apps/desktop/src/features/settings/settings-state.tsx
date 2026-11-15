import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { agentSkillsClient } from "@/lib/api/agent-skills";
import { cliClient } from "@/lib/api/cli";
import { useChatClient } from "@/features/chats/client";
import { useChatFeature } from "@/features/chats/use-chats";
import {
  chatNeedsSetup,
  cliNeedsSetup,
  skillsNeedSetup,
} from "@/features/settings/settings-indicators";

import type { SettingsPageId } from "@/features/settings/settings-sections";
import {
  SettingsStateContext,
  type IndicatorSection,
} from "@/features/settings/use-settings-state";

/** Holds what the nav and the pages share while Settings is open. */
export function SettingsStateProvider({
  active = true,
  onOpenPage = () => {},
  children,
}: {
  /** Opens a Settings page; the page that is open belongs to the parent. */
  onOpenPage?: (page: SettingsPageId) => void;
  /** False while Settings is closed; indicators are read at startup and on each open. */
  active?: boolean;
  children: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [navOpen, setNavOpen] = useState(false);
  const [needsSetup, setNeedsSetup] = useState<
    Partial<Record<IndicatorSection, boolean>>
  >({});
  const chats = useChatClient();
  const { enabled: chatEnabled } = useChatFeature();
  const refreshIndicators = useCallback(
    (section?: IndicatorSection) => {
      const set = (key: IndicatorSection, value: boolean | undefined) =>
        setNeedsSetup((current) => {
          const next = { ...current };
          if (value === undefined) delete next[key];
          else next[key] = value;
          return next;
        });
      const reads = (key: IndicatorSection) =>
        section === undefined || section === key;
      if (reads("command-line"))
        void cliClient.check().then(
          (status) => set("command-line", cliNeedsSetup(status)),
          () => set("command-line", undefined),
        );
      if (reads("agent-skills"))
        void agentSkillsClient.list().then(
          (agents) => set("agent-skills", skillsNeedSetup(agents)),
          () => set("agent-skills", undefined),
        );
      // Harnesses matter only while Chat is shown.
      if (reads("chat")) {
        if (!chatEnabled) set("chat", undefined);
        else
          void chats.harnesses().then(
            (harnesses) => set("chat", chatNeedsSetup(harnesses)),
            () => set("chat", undefined),
          );
      }
    },
    [chats, chatEnabled],
  );
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
  const value = useMemo(
    () => ({
      query,
      setQuery,
      openPage: onOpenPage,
      needsSetup,
      refreshIndicators,
      navOpen,
      setNavOpen,
    }),
    [query, onOpenPage, needsSetup, refreshIndicators, navOpen],
  );
  return (
    <SettingsStateContext.Provider value={value}>
      {children}
    </SettingsStateContext.Provider>
  );
}
