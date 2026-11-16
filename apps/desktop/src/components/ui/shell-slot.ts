import { createContext, use, type ReactNode } from "react";

/**
 * What the shell puts in the leading slot of the view's own header (P14):
 * `nav`, the narrow window's "Open navigation" button, and `crumb`, a
 * ReturnCrumb back to where the view was opened from (the workspace graph).
 * The shell owns both; headers only place them (ShellLeading in
 * list-header.tsx), so nothing is inserted above a pane.
 */
export type ShellSlot = {
  nav: ReactNode;
  crumb: ReactNode;
  notice?: ReactNode;
};

export const ShellSlotContext = createContext<ShellSlot>({
  nav: null,
  crumb: null,
});

/** The shell's leading controls for this header, if any. */
export function useShellSlot(): ShellSlot {
  return use(ShellSlotContext);
}

/** Whether the shell has anything for the leading slot right now. */
export function useShellLeading(): boolean {
  const { nav, crumb } = useShellSlot();
  return Boolean(nav || crumb);
}
