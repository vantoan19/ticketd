import { useState, type ReactNode } from "react";
import type { Returned } from "./catalog";
import type { ChangeSignal } from "./change-signal";
import { fakeChangeSignal } from "./fake-signal";
import { useReads } from "./reads-context";
import { WorkspaceReads } from "./WorkspaceReads";

/**
 * Reads for a test: a fresh cache per mount, driven by a fake change signal
 * instead of the poll. Keep the signal to move it from the test. `primed`
 * fills reads from Tickets before the first render, as if already read.
 */
export function TestReads({
  signal,
  primed,
  children,
}: {
  signal?: ChangeSignal;
  primed?: Returned;
  children: ReactNode;
}) {
  const [own] = useState(() => fakeChangeSignal());
  return (
    <WorkspaceReads signal={signal ?? own}>
      {primed ? <Prime returned={primed}>{children}</Prime> : children}
    </WorkspaceReads>
  );
}

// Fills the cache once, before anything below reads it.
function Prime({
  returned,
  children,
}: {
  returned: Returned;
  children: ReactNode;
}) {
  const reads = useReads("TestReads");
  useState(() => reads.prime(returned));
  return children;
}
