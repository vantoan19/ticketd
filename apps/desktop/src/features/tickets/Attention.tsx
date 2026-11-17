import { useStatusLine } from "@/components/ui/use-status-line";
import { useEffect, useEffectEvent, useState } from "react";
import { useTicket, useTicketChanged } from "./open-ticket";
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
  // What this window last wrote for each Ticket is shown until a read answers
  // after it, so a saved Follow whose re-read failed does not look unsaved. The
  // state belongs to the Ticket it was made on: the toggle stays mounted when
  // the header moves to another one.
  const [written, setWritten] = useState<{
    reference: string;
    value: boolean;
    reread: boolean;
  } | null>(null);
  const mine = written?.reference === reference ? written : null;
  const answered =
    mine !== null && mine.reread && read.failure === null && read.current;
  const following = (mine && !answered ? mine.value : read.value) ?? false;
  // Reading and changing Follow fail separately; a failed change wins until
  // the next try.
  const [changeFailure, setChangeFailure] = useState<{
    reference: string;
    failure: FailureDescription;
  } | null>(null);
  const changeError =
    changeFailure?.reference === reference ? changeFailure.failure : null;
  const [pendingReference, setPendingReference] = useState<string | null>(null);
  const pending = pendingReference === reference;
  const error = changeError ?? read.failure;
  async function toggle() {
    const next = !following;
    setPendingReference(reference);
    try {
      await inboxClient.setFollowing(reference, next);
    } catch (reason) {
      setChangeFailure({
        reference,
        failure: describeFailure(
          reason,
          following ? `unfollow ${reference}` : `follow ${reference}`,
        ),
      });
      setPendingReference(null);
      return;
    }
    setChangeFailure(null);
    setWritten({ reference, value: next, reread: false });
    try {
      await changed();
    } finally {
      setWritten((current) =>
        current?.reference === reference
          ? { ...current, reread: true }
          : current,
      );
      setPendingReference(null);
    }
  }
  const retry = useEffectEvent(() =>
    changeError ? void toggle() : read.retry(),
  );
  useEffect(() => {
    if (variant !== "strip" || !error) return;
    line.show({
      tone: "error",
      message: `${error.title}. ${error.sentence}`,
      action: { label: "Retry", run: () => retry() },
    });
  }, [error, variant, line]);
  const Icon = following ? Eye : EyeOff;
  const failure = error && (
    <FailureCaption
      failure={error}
      label="Not saved"
      onRetry={() => void toggle()}
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
