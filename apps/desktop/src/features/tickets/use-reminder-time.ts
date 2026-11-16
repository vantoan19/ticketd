import { useState } from "react";
import { useNow } from "@/lib/use-now";
import { localInstants } from "./reminder-time";

/** Shared custom-time validation; recheck at the click even if the editor sat idle. */
export function useReminderTime(draft: string, occurrence: string) {
  const now = useNow();
  const [checkedAt, setCheckedAt] = useState(0);
  const instants = localInstants(draft);
  const selected =
    occurrence || (instants.length === 1 ? instants[0]!.toISOString() : "");
  const past =
    Boolean(selected) && Date.parse(selected) <= Math.max(now, checkedAt);
  return {
    instants,
    past,
    selectForSubmit() {
      if (!selected || Date.parse(selected) <= Date.now()) {
        setCheckedAt(Date.now());
        return null;
      }
      return selected;
    },
  };
}
