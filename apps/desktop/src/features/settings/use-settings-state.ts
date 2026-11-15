import { createContext, useContext } from "react";
import type { SettingsPageId } from "@/features/settings/settings-sections";

/** Which nav indicators a page can ask to read again after it changed them. */
export type IndicatorSection = "command-line" | "agent-skills" | "chat";

export interface SettingsState {
  /** The Search page's query; the nav's Search entry shows it. */
  query: string;
  setQuery: (query: string) => void;
  /** Opens another Settings page, for links between pages (Export to Backups, Chat to About). */
  openPage: (page: SettingsPageId) => void;
  /** True when the section needs setup; absent while unknown or unreadable. */
  needsSetup: Partial<Record<IndicatorSection, boolean>>;
  /**
   * Reads the command line, the agent skills or the Chat harnesses again so
   * the nav dot follows a change. Pages call it after a check or an install;
   * no argument reads all of them.
   */
  refreshIndicators: (section?: IndicatorSection) => void;
  /**
   * Below 768px the nav is a sheet; the panel bar's page trigger opens it.
   * Absent where a page is rendered alone.
   */
  navOpen?: boolean;
  setNavOpen?: (open: boolean) => void;
}

export const SettingsStateContext = createContext<SettingsState>({
  query: "",
  setQuery: () => {},
  openPage: () => {},
  needsSetup: {},
  refreshIndicators: () => {},
  navOpen: false,
  setNavOpen: () => {},
});

export function useSettingsState() {
  return useContext(SettingsStateContext);
}
