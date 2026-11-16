import { useCallback, useEffect, useRef, useState } from "react";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
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
  const [error, setError] = useState<FailureDescription | null>(null);
  const generation = useRef(0);
  const reload = useCallback(async () => {
    const request = ++generation.current;
    try {
      const found = await automationsClient.ticketRuns(reference);
      if (request !== generation.current) return false;
      setRuns(found);
      setError(null);
      return true;
    } catch (reason) {
      if (request === generation.current)
        setError(describeFailure(reason, "load this ticket's Automation runs"));
      return false;
    }
  }, [reference]);
  useEffect(() => {
    if (!active) return;
    const readGeneration = generation;
    let current = true;
    void Promise.resolve().then(() => {
      if (current) void reload();
    });
    return () => {
      current = false;
      readGeneration.current++;
    };
  }, [active, version, reload]);
  return {
    runs: active ? runs : [],
    error: active ? error : null,
    reload,
    chatOn,
  };
}
