import { createContext, useContext } from "react";
import type { SettingsPageId } from "@/features/settings/settings-sections";
import type { SetupState } from "@/features/setup/setup-state";

/** Which nav indicators a page can ask to read again after it changed them. */
export type IndicatorSection = "command-line" | "agent-skills" | "agents";

/** What `refreshIndicators` can read again: the indicators, and what Set up ticketd ticks from. */
export type SettingsRead = IndicatorSection | "agent-update";

/** A setting Search opened its page for: the page shows it with a highlight. */
export interface SettingsTarget {
  page: SettingsPageId;
  /** The row's title as its page shows it. */
  title: string;
  /** Distinguishes two openings of the same setting. */
  id: number;
}

export interface SettingsState {
  /** The Search page's query; the nav's Search entry shows it. */
  query: string;
  setQuery: (query: string) => void;
  /** Opens another Settings page, for links between pages (Command line to Agent skills, Agents to About). */
  openPage: (page: SettingsPageId) => void;
  /** True when the section needs setup; absent while unknown or unreadable. */
  needsSetup: Partial<Record<IndicatorSection, boolean>>;
  /**
   * Opens a page from a Search result and asks it to highlight the setting
   * called `title` for a moment.
   */
  openSetting?: (page: SettingsPageId, title: string) => void;
  /** The setting a page is yet to highlight; `SettingsView` takes it. */
  target?: SettingsTarget | null;
  /** Called once the target has been shown. */
  clearTarget?: () => void;
  /**
   * Reads the command line, the agent skills or the Chat harnesses again so
   * the nav dot follows a change. Pages call it after a check or an install;
   * no argument reads all of them.
   */
  refreshIndicators: (
    section?: SettingsRead,
    options?: { refreshPath?: boolean },
  ) => void;
  /**
   * Set up ticketd's five steps, ticked from this computer. Null where Settings
   * is rendered without its provider.
   */
  setup?: SetupState | null;
  /**
   * Whether the sidebar shows the Set up ticketd row: not once the checklist
   * was hidden, and not once it finished before Settings was opened.
   */
  setupRow?: boolean;
  /** Takes the row off the sidebar. The page stays, and Search still finds it. */
  hideSetup?: () => void;
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
  setup: null,
  setupRow: false,
  hideSetup: () => {},
  navOpen: false,
  setNavOpen: () => {},
});

export function useSettingsState() {
  return useContext(SettingsStateContext);
}
