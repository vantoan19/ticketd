import { useEffect, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { FailureCaption } from "@/components/ui/failure-alert";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
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
  const [following, setFollowing] = useState(false);
  const [error, setError] = useState<FailureDescription | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let active = true;
    void inboxClient
      .isFollowing(reference)
      .then((value) => {
        if (active) {
          setFollowing(value);
          setError(null);
        }
      })
      .catch((reason: unknown) => {
        if (active) setError(describeFailure(reason, "check Follow"));
      });
    return () => {
      active = false;
    };
  }, [reference, revision]);
  async function toggle() {
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
          disabled={pending}
          onClick={() => void toggle()}
        >
          <Icon aria-hidden="true" />
        </IconButton>
        <span className="ticket-follow-feedback">{failure}</span>
      </span>
    );
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        aria-label="Follow"
        aria-pressed={following}
        disabled={pending}
        onClick={() => void toggle()}
      >
        <Icon aria-hidden="true" />
        {following ? "Following" : "Follow"}
      </Button>
      {failure}
    </>
  );
}
