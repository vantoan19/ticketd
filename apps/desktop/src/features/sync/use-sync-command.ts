import { useRef, useState } from "react";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import type { SyncStatus } from "@/lib/sync-api";
import { useSyncStatus } from "./sync-status";

/**
 * Runs one sync command at a time and keeps what it failed with. `readable`:
 * the host words its refusals for people (S3), so they are shown as they are.
 */
export function useCommand({ readable = false }: { readable?: boolean } = {}) {
  const { apply } = useSyncStatus();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<FailureDescription | null>(null);
  // Set at once, where `busy` waits for a render: a confirmation that is
  // still closing cannot start its command a second time.
  const running = useRef(false);
  /** `action` says what did not happen: "connect Google Drive". */
  async function run(command: () => Promise<SyncStatus>, action: string) {
    if (running.current) return false;
    running.current = true;
    setBusy(true);
    setFailure(null);
    try {
      apply(await command());
      return true;
    } catch (reason) {
      setFailure(describeFailure(reason, action, { readable }));
      return false;
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return { busy, failure, run };
}
