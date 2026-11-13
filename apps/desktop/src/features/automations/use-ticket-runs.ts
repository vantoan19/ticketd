import { useCallback, useEffect, useState } from "react";
import {
  automationsClient,
  type TicketRun,
} from "@/features/automations/client";
import { useChatFeature } from "@/features/chats/use-chats";
import { useWorkspaceChange } from "@/lib/workspace-change";

/**
 * The runs that acted on a ticket, newest first, following the Workspace. Empty
 * while Chat is off, when Automations are not shown anywhere.
 */
export function useTicketRuns(reference: string, active: boolean) {
  const shown = useChatFeature().enabled && active;
  const version = useWorkspaceChange();
  const [runs, setRuns] = useState<TicketRun[]>([]);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!shown) return;
    let current = true;
    void automationsClient.ticketRuns(reference).then(
      (found) => current && setRuns(found),
      (reason: unknown) => current && setError(String(reason)),
    );
    return () => {
      current = false;
    };
  }, [reference, shown, version, tick]);
  const reload = useCallback(() => setTick((value) => value + 1), []);
  return { runs: shown ? runs : [], error: shown ? error : "", reload };
}
