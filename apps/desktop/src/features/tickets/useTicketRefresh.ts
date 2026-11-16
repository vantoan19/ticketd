import { useState } from "react";
import { sourcesClient } from "@/lib/api/sources";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";

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
  const [failure, setFailure] = useState<FailureDescription | null>(null);
  async function run() {
    setRunning(true);
    setFailure(null);
    try {
      const report = await sourcesClient.refresh(reference);
      const first = report.failures[0];
      if (first) {
        // Source reports retain transport diagnostics; only shared public copy is shown.
        const described = describeFailure(
          { code: first.code, message: first.message },
          `refresh ${reference}`,
        );
        setFailure({
          ...described,
          sentence: `${described.sentence} Saved content is unchanged.`,
        });
      }
      await refresh();
    } catch (reason) {
      setFailure(describeFailure(reason, `refresh ${reference}`));
    } finally {
      setRunning(false);
    }
  }
  return { running, failure, run };
}
