import { useEffect, useEffectEvent, useState } from "react";
import { useStatusLine } from "@/components/ui/use-status-line";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { inboxClient } from "@/lib/api/inbox";
import { editingBlockedReason, useWorkspaceState } from "@/lib/workspace-state";
import { followingFill, useTicket, useTicketChanged } from "./open-ticket";

/** Keep the Follow read, pending write and error alive even while its menu is closed. */
export function useFollow(
  reference: string | null,
  reportInStatusLine = false,
) {
  const blocked = editingBlockedReason(useWorkspaceState()) !== null;
  const line = useStatusLine();
  const read = useTicket(reference, "following");
  const changed = useTicketChanged();
  const following = read.value ?? false;
  // Reading and changing Follow fail separately; a failed change wins until
  // the next try. The toggle stays mounted when the header moves to another
  // Ticket, so what is out and what failed are kept for each Ticket, and a
  // Ticket's own write finishing touches only its own entry.
  const [pendingReferences, setPendingReferences] = useState<
    ReadonlySet<string>
  >(new Set());
  const [changeFailures, setChangeFailures] = useState<
    Readonly<Record<string, FailureDescription>>
  >({});
  const pending = reference !== null && pendingReferences.has(reference);
  const changeError =
    reference === null ? null : (changeFailures[reference] ?? null);
  const error = changeError ?? read.failure;
  function setPending(target: string, on: boolean) {
    setPendingReferences((current) => {
      const next = new Set(current);
      if (on) next.add(target);
      else next.delete(target);
      return next;
    });
  }
  function setChangeFailure(
    target: string,
    failure: FailureDescription | null,
  ) {
    setChangeFailures((current) => {
      const others = Object.entries(current).filter(([key]) => key !== target);
      return Object.fromEntries(
        failure ? [...others, [target, failure]] : others,
      );
    });
  }
  async function toggle() {
    const target = reference;
    if (!target || pending || blocked) return;
    const next = !following;
    setPending(target, true);
    try {
      await inboxClient.setFollowing(target, next);
    } catch (reason) {
      setChangeFailure(
        target,
        describeFailure(
          reason,
          following ? `unfollow ${target}` : `follow ${target}`,
        ),
      );
      setPending(target, false);
      return;
    }
    try {
      await changed(undefined, [followingFill(target, next)]);
    } finally {
      setChangeFailure(target, null);
      setPending(target, false);
    }
  }
  // A failed read offers a read again; a failed change offers sending it again.
  // Both settle when that action does, so the status line stays busy until
  // then.
  const retry = (): Promise<void> => (changeError ? toggle() : read.retry());
  // A line is about the Ticket it was shown for: once the header moves on it
  // goes (below), and a Retry that still reaches here does nothing.
  const retryFromLine = useEffectEvent((target: string) =>
    target === reference ? retry() : Promise.resolve(),
  );
  useEffect(() => {
    if (!reportInStatusLine || !error || !reference) return;
    return line.show({
      tone: "error",
      message: `${error.title}. ${error.sentence}`,
      action: { label: "Retry", run: () => retryFromLine(reference) },
    });
  }, [error, reportInStatusLine, line, reference]);
  return {
    following,
    blocked: blocked || pending,
    toggle,
    error,
    changeError,
    retry,
  };
}
