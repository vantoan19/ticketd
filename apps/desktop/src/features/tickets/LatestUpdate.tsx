import { progressBrief } from "./progress-brief";
import { useEffect, useState } from "react";
import { Bot, User } from "lucide-react";
import { FailureState } from "@/components/ui/failure-alert";
import { Skeleton } from "@/components/ui/skeleton";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { latestUpdate, type LatestUpdate as Update } from "@/lib/api/progress";
import { formatDateTime, relativeDateTime } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { RailSection } from "./RailSection";

/**
 * The latest authored update of an In progress or In review ticket. In the
 * rail it is one button: "codex · 5 h ago" over a two-line excerpt, opening
 * the update in Activity. In the property strip (`line`) it is one line,
 * "codex · 5 h ago  Drafted a fix…".
 */
export function LatestUpdate({
  reference,
  active,
  revision,
  onOpen,
  variant = "rail",
}: {
  reference: string;
  active: boolean;
  revision: number;
  onOpen?: ((id: string) => void) | undefined;
  variant?: "rail" | "line";
}) {
  const now = useNow();
  const [state, setState] = useState<{
    update: Update | null;
    error: FailureDescription | null;
    loading: boolean;
  }>({ update: null, error: null, loading: true });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!active) return;
    let current = true;
    void latestUpdate(reference)
      .then((update) => {
        if (current) setState({ update, error: null, loading: false });
      })
      .catch((error: unknown) => {
        if (current)
          setState({
            update: null,
            error: describeFailure(error, "load the latest update"),
            loading: false,
          });
      });
    return () => {
      current = false;
    };
  }, [active, reference, revision, retry]);
  const { update, error, loading } = state;
  const who = update?.editing_agent ?? "You";
  const Icon = update?.editing_agent ? Bot : User;
  const when = update && (
    <span>
      {who} · {relativeDateTime(update.reported_at, now)}
      {update.updated_at !== update.reported_at && " · edited"}
    </span>
  );
  const text =
    update &&
    `${progressBrief(update.brief.text)}${update.brief.truncated ? "…" : ""}`;
  const exact = update
    ? `Reported ${formatDateTime(update.reported_at)}${
        update.updated_at !== update.reported_at
          ? `, edited ${formatDateTime(update.updated_at)}`
          : ""
      }`
    : undefined;
  if (variant === "line") {
    if (loading) return <Skeleton className="h-7 w-full" />;
    if (error)
      return (
        <FailureState
          size="inline"
          failure={error}
          onRetry={() => setRetry((n) => n + 1)}
        />
      );
    if (!update) return null;
    return (
      <button
        type="button"
        className="latest-update-line"
        aria-label={`Go to update: ${text}`}
        aria-description={exact}
        onClick={() => onOpen?.(update.activity_id)}
      >
        <Icon aria-hidden="true" />
        {when}
        <span>{text}</span>
      </button>
    );
  }

  return (
    <RailSection label="Latest update">
      {loading ? (
        <Skeleton className="h-8" />
      ) : error ? (
        <FailureState
          size="inline"
          failure={error}
          onRetry={() => setRetry((n) => n + 1)}
        />
      ) : update ? (
        <button
          type="button"
          className="latest-update"
          aria-label={`Go to update: ${text}`}
          aria-description={exact}
          onClick={() => onOpen?.(update.activity_id)}
        >
          <span className="latest-update-meta">
            <Icon aria-hidden="true" />
            {when}
          </span>
          <span className="latest-update-text">{text}</span>
        </button>
      ) : (
        <small className="rail-note">No update reported</small>
      )}
    </RailSection>
  );
}
