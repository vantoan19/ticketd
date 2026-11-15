import { use, useEffect, useState } from "react";
import { automationsClient } from "@/features/automations/client";
import { RunNavigation } from "@/features/automations/navigation";
import { TakenOverLine } from "@/features/automations/TakenOver";

/**
 * The line for a Chat in the Chat list: nothing unless the Chat was a run's
 * and the person took it over.
 */
export function useTakenOverLine(chatId: string | null) {
  const openRun = use(RunNavigation);
  const [found, setFound] = useState<{
    chatId: string;
    runId: string;
    automationName: string;
  } | null>(null);
  useEffect(() => {
    if (!chatId) return;
    let current = true;
    void automationsClient.takenOverIn(chatId).then(
      (run) =>
        current &&
        setFound(
          run && {
            chatId,
            runId: run.id,
            automationName: run.automation_name,
          },
        ),
      // The line is a courtesy; the Chat works without it.
      () => {},
    );
    return () => {
      current = false;
    };
  }, [chatId]);
  if (!found || found.chatId !== chatId || !openRun) return null;
  return (
    <TakenOverLine
      automationName={found.automationName}
      onViewRun={() => openRun(found.runId)}
    />
  );
}
