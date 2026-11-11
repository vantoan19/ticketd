import { useCallback, useEffect, useState } from "react";
import { syncReview, type ConflictSummary } from "@/lib/sync-review-api";
import { useWorkspaceChange } from "@/lib/workspace-change";

/**
 * The records that Need review, refreshed whenever the Workspace changes. A
 * Workspace without sync has none, so a failed read is an empty list.
 */
export function useConflicts(): {
  conflicts: ConflictSummary[];
  reload: () => void;
} {
  const [conflicts, setConflicts] = useState<ConflictSummary[]>([]);
  const [tick, setTick] = useState(0);
  const change = useWorkspaceChange();
  useEffect(() => {
    let active = true;
    syncReview.conflicts().then(
      (found) => {
        if (active) setConflicts(found);
      },
      () => {
        if (active) setConflicts([]);
      },
    );
    return () => {
      active = false;
    };
  }, [change, tick]);
  const reload = useCallback(() => setTick((value) => value + 1), []);
  return { conflicts, reload };
}
