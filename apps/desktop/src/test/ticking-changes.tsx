import { useEffect, useState, type ReactNode } from "react";
import { fakeChangeSignal } from "@/lib/workspace-reads/fake-signal";
import { TestReads } from "@/lib/workspace-reads/testing";

/**
 * Reports a workspace change every two seconds, as a busy workspace would. It
 * moves both `useWorkspaceChange` and the reads of `lib/workspace-reads`, and
 * gives them a fresh cache.
 */
export function TickingChanges({ children }: { children: ReactNode }) {
  const [signal] = useState(() => fakeChangeSignal());
  useEffect(() => {
    const timer = window.setInterval(() => signal.change(), 2000);
    return () => window.clearInterval(timer);
  }, [signal]);
  return <TestReads signal={signal}>{children}</TestReads>;
}
