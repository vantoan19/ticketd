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
  const following = read.value ?? false;
  // Reading and changing Follow fail separately; a failed change wins until
  // the next try.
  const [changeError, setChangeError] = useState<FailureDescription | null>(
    null,
  );
  const [pending, setPending] = useState(false);
  const error = changeError ?? read.failure;
  async function toggle() {
    setPending(true);
    try {
      await inboxClient.setFollowing(reference, !following);
      setChangeError(null);
      await changed();
    } catch (reason) {
      setChangeError(
        describeFailure(
          reason,
          following ? `unfollow ${reference}` : `follow ${reference}`,
        ),
      );
    } finally {
      setPending(false);
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
