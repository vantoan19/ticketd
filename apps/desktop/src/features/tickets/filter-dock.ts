import { createContext, useContext } from "react";

/**
 * Where the Filters panel docks. The workspace owns whether the panel is open
 * (so the detail pane can make room for it) and which element it sits beside.
 */
export type FilterDock = {
  open: boolean;
  setOpen: (open: boolean) => void;
  /** The List pane's right edge, or null to use the trigger and viewport collision handling. */
  anchor: { current: HTMLElement | null } | null;
};

export const FilterDockContext = createContext<FilterDock | null>(null);

export function useFilterDock(): FilterDock | null {
  return useContext(FilterDockContext);
}
