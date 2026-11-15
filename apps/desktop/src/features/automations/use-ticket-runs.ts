import { useCallback, useEffect, useState } from "react";
import {
  automationsClient,
  type TicketRun,
} from "@/features/automations/client";
import { useChatFeature } from "@/features/chats/use-chats";
import { useWorkspaceChange } from "@/lib/workspace-change";

/**
 * The runs that acted on a ticket, newest first, following the Workspace. Read
 * while Chat is off too: a run that needs attention still says so on its
 * ticket, though nothing can open it until Chat is on (`chatOn`).
 */
export function useTicketRuns(reference: string, active: boolean) {
  const chatOn = useChatFeature().enabled;
  const version = useWorkspaceChange();
  const [runs, setRuns] = useState<TicketRun[]>([]);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    let current = true;
    void automationsClient.ticketRuns(reference).then(
      (found) => {
        if (!current) return;
        setRuns(found);
        // A read that works again takes the earlier failure off the ticket.
        setError("");
      },
      (reason: unknown) => current && setError(String(reason)),
    );
    return () => {
      current = false;
    };
  }, [reference, active, version, tick]);
  const reload = useCallback(() => setTick((value) => value + 1), []);
  return {
    runs: active ? runs : [],
    error: active ? error : "",
    reload,
    chatOn,
  };
}
