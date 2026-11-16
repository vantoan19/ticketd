import { useStatusLine } from "@/components/ui/use-status-line";
import { useEffect, useEffectEvent, useState } from "react";
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
  revision,
  variant = "rail",
}: {
  reference: string;
  revision: number;
  variant?: "rail" | "strip";
}) {
  const blocked = editingBlockedReason(useWorkspaceState()) !== null;
  const line = useStatusLine();
  const [readAttempt, setReadAttempt] = useState(0);
  const [readFailed, setReadFailed] = useState(false);
  const [following, setFollowing] = useState(false);
  const [error, setError] = useState<FailureDescription | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let active = true;
    void inboxClient
      .isFollowing(reference)
      .then((value) => {
        if (active) {
          setReadFailed(false);
          setFollowing(value);
          setError(null);
        }
      })
      .catch((reason: unknown) => {
        if (active) {
          setReadFailed(true);
          setError(describeFailure(reason, "check Follow"));
        }
      });
    return () => {
      active = false;
    };
  }, [reference, revision, readAttempt]);
  async function toggle() {
    setReadFailed(false);
    setPending(true);
    try {
      await inboxClient.setFollowing(reference, !following);
      setFollowing(!following);
      setError(null);
    } catch (reason) {
      setError(
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
    readFailed ? setReadAttempt((n) => n + 1) : void toggle(),
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
