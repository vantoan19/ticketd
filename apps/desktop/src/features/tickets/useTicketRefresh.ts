import { useState } from "react";
import { sourcesClient } from "@/lib/api/sources";

/**
 * Refreshes one externally owned ticket now and says how it went, for every
 * place that offers it (the rail's Refresh and the unavailable notice's Retry).
 * Saved content stays in place whatever happens; only the outcome is reported.
 */
export function useTicketRefresh(
  reference: string,
  refresh: () => Promise<void>,
) {
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState("");
  async function run() {
    setRunning(true);
    setFailure("");
    try {
      const report = await sourcesClient.refresh(reference);
      const first = report.failures[0];
      if (first) setFailure(first.message);
      await refresh();
    } catch (reason) {
      setFailure(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRunning(false);
    }
  }
  return { running, failure, run };
}
