import { useEffect, useRef } from "react";
import { onAction } from "@tauri-apps/plugin-notification";
import { z } from "zod";

/** What a Notify me notification carries, set where the desktop shows it. */
const targetSchema = z.object({
  opens: z.enum(["ticket", "run"]),
  ticket_reference: z.string().nullable(),
  automation_id: z.string(),
  run_id: z.string(),
});
export type RunTarget = { automationId: string; runId: string };

/**
 * Opens what a Notify me notification points to when the person clicks it: the
 * ticket, or the run. The desktop shows these notifications itself and brings
 * the window back on a click; this only navigates. Off while `enabled` is false.
 */
export function useAutomationNotifications(
  enabled: boolean,
  openTicket: (reference: string) => void,
  openRun: (target: RunTarget) => void,
) {
  const open = useRef({ openTicket, openRun });
  useEffect(() => {
    open.current = { openTicket, openRun };
  });
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let stop: (() => void) | undefined;
    onAction((event) => {
      if (event.actionId !== "tap") return;
      const target = targetSchema.safeParse(
        event.notification?.extra?.automation,
      ).data;
      if (!target) return;
      if (target.opens === "ticket" && target.ticket_reference)
        open.current.openTicket(target.ticket_reference);
      else
        open.current.openRun({
          automationId: target.automation_id,
          runId: target.run_id,
        });
    }).then(
      (listener) => {
        const unregister = () => void listener.unregister().catch(() => {});
        if (active) stop = unregister;
        else unregister();
      },
      // Without a listener the notifications still appear; a click opens nothing.
      () => {},
    );
    return () => {
      active = false;
      stop?.();
    };
  }, [enabled]);
}
