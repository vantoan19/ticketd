import { useRef, useState } from "react";
import { useStatusLine } from "@/components/ui/use-status-line";
import { client, type Project } from "@/lib/api/client";
import { describeFailure } from "@/lib/api/describe-failure";

type FocusRecovery = {
  beforeRefresh?: () => void;
  beforeUndoRefresh?: () => void;
};

/** Keep the same messages, Undo, and failure behavior wherever Projects can change state. */
export function useProjectLifecycle(refresh: () => Promise<void>) {
  const status = useStatusLine();
  const saving = useRef(new Set<string>());
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());

  async function change(
    project: Project,
    archived: boolean,
    focus: FocusRecovery = {},
  ) {
    if (saving.current.has(project.id)) return;
    saving.current.add(project.id);
    setPending(new Set(saving.current));
    try {
      await client.setProjectArchived(project.id, archived);
      focus.beforeRefresh?.();
      await refresh();
      status.show({
        message: `${archived ? "Archived" : "Reactivated"} ${project.name}`,
        undo: async () => {
          const undo = document.activeElement;
          const undoFocused =
            undo instanceof HTMLButtonElement &&
            undo.closest('[data-slot="status-line"]') &&
            undo.textContent === "Undo";
          await client.setProjectArchived(project.id, !archived);
          if (
            undoFocused &&
            (document.activeElement === undo ||
              document.activeElement === document.body)
          ) {
            focus.beforeUndoRefresh?.();
          }
          await refresh();
        },
      });
    } catch (reason) {
      const failure = describeFailure(
        reason,
        `${archived ? "archive" : "reactivate"} ${project.name}`,
      );
      status.show({
        tone: "error",
        message: `${failure.title}. ${failure.sentence}`,
        details: failure.details,
        ...(failure.action === "retry" && {
          focusAction: true,
          action: {
            label: "Retry",
            run: () => change(project, archived, focus),
          },
        }),
      });
    } finally {
      saving.current.delete(project.id);
      setPending(new Set(saving.current));
    }
  }

  return { change, pending };
}
