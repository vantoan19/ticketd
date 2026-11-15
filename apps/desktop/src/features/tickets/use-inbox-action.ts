import { useRef, useState } from "react";
import {
  useStatusLine,
  type StatusLine,
} from "@/components/ui/use-status-line";
import { describeFailure } from "@/lib/api/describe-failure";

/** One outcome surface, with the original operation retained for an explicit Retry. */
export function useInboxAction(
  reload: () => void | Promise<void>,
  sharedLine?: StatusLine,
) {
  const paneLine = useStatusLine();
  const line = sharedLine ?? paneLine;
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  async function perform(
    message: string,
    action: () => Promise<void>,
    undo?: () => Promise<void>,
  ) {
    if (busy.current) return;
    const retry = async () => {
      busy.current = true;
      setPending(true);
      try {
        await action();
        await reload();
        if (undo)
          line.show({
            message,
            undo: async () => {
              await undo();
              await reload();
            },
          });
      } catch (reason) {
        const failure = describeFailure(reason, "save the Inbox action");
        line.show({
          tone: "error",
          message: `${failure.title}. ${failure.sentence}`,
          action: { label: "Retry", run: retry },
        });
      } finally {
        busy.current = false;
        setPending(false);
      }
    };
    await retry();
  }
  return { pending, perform };
}
