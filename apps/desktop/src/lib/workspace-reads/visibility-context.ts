import { createContext, useContext, useSyncExternalStore } from "react";

export const HiddenContext = createContext(false);

function subscribe(onChange: () => void) {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

/**
 * Whether reads here may fetch: no enclosing Visibility is hidden and the window
 * is not minimized. An unfocused but visible window counts as visible.
 */
export function useVisible(): boolean {
  const hidden = useContext(HiddenContext);
  const shown = useSyncExternalStore(
    subscribe,
    () => document.visibilityState !== "hidden",
    () => true,
  );
  return shown && !hidden;
}
