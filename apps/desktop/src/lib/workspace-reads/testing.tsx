import { useState, type ReactNode } from "react";
import type { ChangeSignal } from "./change-signal";
import { fakeChangeSignal } from "./fake-signal";
import { WorkspaceReads } from "./WorkspaceReads";

/**
 * Reads for a test: a fresh cache per mount, driven by a fake change signal
 * instead of the poll. Keep the signal to move it from the test.
 */
export function TestReads({
  signal,
  children,
}: {
  signal?: ChangeSignal;
  children: ReactNode;
}) {
  const [own] = useState(() => fakeChangeSignal());
  return <WorkspaceReads signal={signal ?? own}>{children}</WorkspaceReads>;
}
