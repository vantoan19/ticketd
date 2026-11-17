import { useRef, useState } from "react";
import {
  useStatusLine,
  type StatusLine,
} from "@/components/ui/use-status-line";
import type { Ticket } from "@/lib/api/client";
import { describeFailure } from "@/lib/api/describe-failure";

/** One outcome surface, with the original operation retained for an explicit Retry. */
export function useInboxAction(
  reload: (returned?: Ticket) => void | Promise<void>,
  sharedLine?: StatusLine,
  concurrent = false,
) {
  const paneLine = useStatusLine();
  const line = sharedLine ?? paneLine;
  const busy = useRef(0);
  const [pending, setPending] = useState(false);
  async function perform(
    message: string,
    action: () => Promise<Ticket | void>,
    undo?: () => Promise<Ticket | void>,
    failureAction = "save the Inbox action",
    afterUndo?: { action: string; run: () => Promise<void> },
  ) {
    if (busy.current > 0 && !concurrent) return;
    // What an Undo leaves to do once its write was reported. Its failure is its
    // own: the write landed, so the line must not say the Undo failed.
    const followUp = async () => {
      if (!afterUndo) return;
      try {
        await afterUndo.run();
      } catch (reason) {
        const failure = describeFailure(reason, afterUndo.action);
        line.show({
          tone: "error",
          message: `${failure.title}. ${failure.sentence}`,
          details: failure.details,
          action: { label: "Retry", run: followUp },
        });
      }
    };
    const retry = async () => {
      busy.current += 1;
      setPending(true);
      try {
        await reload((await action()) ?? undefined);
        if (undo)
          line.show({
            message,
            undo: async () => {
              await reload((await undo()) ?? undefined);
              await followUp();
            },
          });
      } catch (reason) {
        const failure = describeFailure(reason, failureAction);
        line.show({
          tone: "error",
          message: `${failure.title}. ${failure.sentence}`,
          details: failure.details,
          action: { label: "Retry", run: retry },
        });
      } finally {
        busy.current -= 1;
        setPending(busy.current > 0);
      }
    };
    await retry();
  }
  return { pending, perform };
}
