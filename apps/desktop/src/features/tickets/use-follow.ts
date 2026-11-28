import { useEffect, useEffectEvent, useState } from "react";
import { useStatusLine } from "@/components/ui/use-status-line";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { inboxClient } from "@/lib/api/inbox";
import { editingBlockedReason, useWorkspaceState } from "@/lib/workspace-state";
import { followingFill, useTicket, useTicketChanged } from "./open-ticket";

type ChangeFailure = { following: boolean; failure: FailureDescription };

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
    Readonly<Record<string, ChangeFailure>>
  >({});
  const pending = reference !== null && pendingReferences.has(reference);
  const failedChange =
    reference === null ? null : (changeFailures[reference] ?? null);
  const changeError = failedChange?.failure ?? null;
  const error = changeError ?? read.failure;
  function setPending(target: string, on: boolean) {
    setPendingReferences((current) => {
      const next = new Set(current);
      if (on) next.add(target);
      else next.delete(target);
      return next;
    });
  }
  function setChangeFailure(target: string, failure: ChangeFailure | null) {
    setChangeFailures((current) => {
      const others = Object.entries(current).filter(([key]) => key !== target);
      return Object.fromEntries(
        failure ? [...others, [target, failure]] : others,
      );
    });
  }
  async function setFollowing(next: boolean) {
    const target = reference;
    if (!target || pending || blocked) return;
    setPending(target, true);
    try {
      await inboxClient.setFollowing(target, next);
    } catch (reason) {
      setChangeFailure(target, {
        following: next,
        failure: describeFailure(
          reason,
          next ? `follow ${target}` : `unfollow ${target}`,
        ),
      });
      setPending(target, false);
      return;
    }
    setChangeFailure(target, null);
    try {
      await changed(undefined, [followingFill(target, next)]);
    } finally {
      setPending(target, false);
    }
  }
  // A failed read offers a read again; a failed change offers sending it again.
  // Both settle when that action does, so the status line stays busy until
  // then.
  const canRetry = !failedChange || !blocked;
  const retry = canRetry
    ? () => (failedChange ? setFollowing(failedChange.following) : read.retry())
    : undefined;
  // A line is about the Ticket it was shown for: once the header moves on it
  // goes (below), and a Retry that still reaches here does nothing.
  const retryFromLine = useEffectEvent((target: string) =>
    target === reference ? retry?.() : undefined,
  );
  useEffect(() => {
    if (!reportInStatusLine || !error || !reference) return;
    return line.show({
      tone: "error",
      message: `${error.title}. ${error.sentence}`,
      ...(canRetry && {
        action: { label: "Retry", run: () => retryFromLine(reference) },
      }),
    });
  }, [canRetry, error, reportInStatusLine, line, reference]);
  return {
    following,
    blocked: blocked || pending,
    toggle: () => setFollowing(!following),
    error,
    changeError,
    retry,
  };
}
