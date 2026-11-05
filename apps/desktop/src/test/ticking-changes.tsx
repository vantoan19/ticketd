import { useEffect, useState, type ReactNode } from "react";
import { WorkspaceChangeProvider } from "@/lib/workspace-change";

/** Reports a workspace change every two seconds, as a busy workspace would. */
export function TickingChanges({ children }: { children: ReactNode }) {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setVersion((v) => v + 1), 2000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <WorkspaceChangeProvider value={version}>
      {children}
    </WorkspaceChangeProvider>
  );
}
