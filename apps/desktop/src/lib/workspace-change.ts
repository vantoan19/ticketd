import { createContext, useContext, useEffect, useRef } from "react";

// The version is provided by WorkspaceReads (lib/workspace-reads), which owns the change
// poll; it moves when the Workspace changed and when the desktop made its own write.
const WorkspaceChangeContext = createContext(0);

export const WorkspaceChangeProvider = WorkspaceChangeContext.Provider;

/** Increases each time workspace data changed; use it as an effect dependency. */
export function useWorkspaceChange(): number {
  return useContext(WorkspaceChangeContext);
}

/**
 * Runs `callback` when workspace data changed while `enabled`, never on mount. A change that
 * happened while disabled is delivered once it is enabled again, so a view kept mounted but
 * hidden catches up when it is shown.
 */
export function useOnWorkspaceChange(callback: () => void, enabled = true) {
  const version = useWorkspaceChange();
  const seen = useRef(version);
  const latest = useRef(callback);
  useEffect(() => {
    latest.current = callback;
  });
  useEffect(() => {
    if (!enabled) return;
    if (seen.current === version) return;
    seen.current = version;
    latest.current();
  }, [version, enabled]);
}
