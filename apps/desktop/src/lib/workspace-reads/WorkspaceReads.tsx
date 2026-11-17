import { useCallback, useEffect, useState, type ReactNode } from "react";
import { WorkspaceChangeProvider } from "@/lib/workspace-change";
import { pollWorkspaceChanges, type ChangeSignal } from "./change-signal";
import { createReads } from "./engine";
import { ReadsContext } from "./reads-context";

/**
 * The root of workspace reads. It owns the cache and the change signal (the
 * core's change token, polled every two seconds, unless a test passes its own),
 * and keeps feeding `useWorkspaceChange` for views not yet on this module. The
 * signal is read once, on mount.
 */
export function WorkspaceReads({
  signal,
  children,
}: {
  signal?: ChangeSignal;
  children: ReactNode;
}) {
  const [version, setVersion] = useState(0);
  const [polled] = useState(() => pollWorkspaceChanges());
  const source = signal ?? polled;
  const moved = useCallback(() => setVersion((value) => value + 1), []);
  const [reads] = useState(() => createReads(source, moved));
  useEffect(() => source.subscribe(reads.changed), [source, reads]);
  return (
    <ReadsContext.Provider value={reads}>
      <WorkspaceChangeProvider value={version}>
        {children}
      </WorkspaceChangeProvider>
    </ReadsContext.Provider>
  );
}
