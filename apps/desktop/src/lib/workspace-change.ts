import { createContext, useContext, useEffect, useRef, useState } from "react";
import { changesClient } from "@/lib/api/changes";

const POLL_MS = 2000;

const WorkspaceChangeContext = createContext(0);

/**
 * The one workspace poll. It asks the core for a single change token every two
 * seconds and counts how often it moved, so changes made by the CLI or an agent
 * reach the screen within that time while views never poll on their own.
 */
export function useWorkspaceChangePoll(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let active = true;
    let last: number | null = null;
    const poll = () =>
      void changesClient
        .token()
        .then((token) => {
          if (!active) return;
          if (last !== null && token !== last) setVersion((value) => value + 1);
          last = token;
        })
        .catch(() => {});
    poll();
    const timer = window.setInterval(poll, POLL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);
  return version;
}

export const WorkspaceChangeProvider = WorkspaceChangeContext.Provider;

/** Increases each time workspace data changed; use it as an effect dependency. */
export function useWorkspaceChange(): number {
  return useContext(WorkspaceChangeContext);
}

/** Runs `callback` when workspace data changed while `enabled`, never on mount. */
export function useOnWorkspaceChange(callback: () => void, enabled = true) {
  const version = useWorkspaceChange();
  const seen = useRef(version);
  const latest = useRef(callback);
  useEffect(() => {
    latest.current = callback;
  });
  useEffect(() => {
    if (!enabled || seen.current === version) {
      seen.current = version;
      return;
    }
    seen.current = version;
    latest.current();
  }, [version, enabled]);
}
