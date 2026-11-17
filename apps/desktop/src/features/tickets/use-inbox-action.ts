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
  ) {
    if (busy.current > 0 && !concurrent) return;
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
