import { progressBrief } from "./progress-brief";
import { Bot, User } from "lucide-react";
import { FailureState } from "@/components/ui/failure-alert";
import { Skeleton } from "@/components/ui/skeleton";
import type { FailureDescription } from "@/lib/api/describe-failure";
import type { LatestUpdate as Update } from "@/lib/api/progress";
import { formatDateTime, relativeDateTime } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { RailSection } from "./RailSection";
import { useOpenTicket } from "./open-ticket";

/**
 * The latest authored update of an In progress or In review ticket. In the
 * rail it is one button: "codex · 5 h ago" over a two-line excerpt, opening
 * the update in Activity. In the property strip (`line`) it is one line,
 * "codex · 5 h ago  Drafted a fix…".
 */
export function LatestUpdate({
  active,
  onOpen,
  variant = "rail",
}: {
  /** False while the page is only a saved copy: the update is not asked for yet. */
  active: boolean;
  onOpen?: ((id: string) => void) | undefined;
  variant?: "rail" | "line";
}) {
  return active ? (
    <Reported onOpen={onOpen} variant={variant} />
  ) : (
    <Preview
      update={null}
      error={null}
      loading
      retry={() => {}}
      onOpen={onOpen}
      variant={variant}
    />
  );
}

function Reported({
  onOpen,
  variant,
}: {
  onOpen: ((id: string) => void) | undefined;
  variant: "rail" | "line";
}) {
  const { value, failure, retry } = useOpenTicket("latestUpdate");
  return (
    <Preview
      update={value ?? null}
      error={value === undefined ? failure : null}
      loading={value === undefined && failure === null}
      retry={retry}
      onOpen={onOpen}
      variant={variant}
    />
  );
}

function Preview({
  update,
  error,
  loading,
  retry,
  onOpen,
  variant,
}: {
  update: Update | null;
  error: FailureDescription | null;
  loading: boolean;
  retry: () => void;
  onOpen: ((id: string) => void) | undefined;
  variant: "rail" | "line";
}) {
  const now = useNow();
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
          onRetry={retry}
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
          onRetry={retry}
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
