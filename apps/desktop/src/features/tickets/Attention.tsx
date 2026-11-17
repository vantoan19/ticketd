import { useStatusLine } from "@/components/ui/use-status-line";
import { useEffect, useEffectEvent, useState } from "react";
import { followingFill, useTicket, useTicketChanged } from "./open-ticket";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { FailureCaption } from "@/components/ui/failure-alert";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { editingBlockedReason, useWorkspaceState } from "@/lib/workspace-state";
import { inboxClient } from "@/lib/api/inbox";

/**
 * Follow as a pressed toggle (one control in both layouts): in the rail's
 * Attention row a ghost button with the eye and "Follow" or "Following"; in
 * the property strip an icon toggle whose tooltip says the same. Its name is
 * always "Follow" and `aria-pressed` carries the state.
 */
export function FollowToggle({
  reference,
  variant = "rail",
}: {
  reference: string;
  variant?: "rail" | "strip";
}) {
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
  const pending = pendingReferences.has(reference);
  const changeError = changeFailures[reference] ?? null;
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
    setChangeFailure(target, null);
    try {
      await changed(undefined, [followingFill(target, next)]);
    } finally {
      setPending(target, false);
    }
  }
  // A failed read offers a read again; a failed change offers sending it again.
  const retry = () => (changeError ? void toggle() : void read.retry());
  const retryFromLine = useEffectEvent(retry);
  useEffect(() => {
    if (variant !== "strip" || !error) return;
    line.show({
      tone: "error",
      message: `${error.title}. ${error.sentence}`,
      action: { label: "Retry", run: () => retryFromLine() },
    });
  }, [error, variant, line]);
  const Icon = following ? Eye : EyeOff;
  const failure = error && (
    <FailureCaption
      failure={error}
      label={changeError ? "Not saved" : "Not checked"}
      onRetry={() => retry()}
    />
  );
  if (variant === "strip")
    return (
      <span className="ticket-follow-slot">
        <IconButton
          label={following ? "Following" : "Follow"}
          aria-label="Follow"
          aria-pressed={following}
          disabled={pending || blocked}
          onClick={() => void toggle()}
        >
          <Icon aria-hidden="true" />
        </IconButton>
      </span>
    );
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        aria-label="Follow"
        aria-pressed={following}
        disabled={pending || blocked}
        onClick={() => void toggle()}
      >
        <Icon aria-hidden="true" />
        {following ? "Following" : "Follow"}
      </Button>
      {failure}
    </>
  );
}
