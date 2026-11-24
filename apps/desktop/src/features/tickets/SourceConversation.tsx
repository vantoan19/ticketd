import { EmptyState } from "@/components/ui/empty-state";
import { Tooltip } from "@/components/ui/tooltip";
import { CommentRow, EventRow, Timeline } from "@/components/ui/timeline";
import { SectionHeader } from "@/components/ui/section-header";
import { FailureState } from "@/components/ui/failure-alert";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { useEffect, useState } from "react";
import {
  CircleAlert,
  LockKeyhole,
  MessageSquare,
  Circle,
  UserMinus,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import { MarkdownDocument } from "@/features/markdown/MarkdownDocument";
import { SourceLink } from "@/features/tickets/SourceLink";

import { client } from "@/lib/api/client";
import type { ConversationEntry, TicketSource } from "@/lib/api/client";
import { useNow } from "@/lib/use-now";
import { relativeDateTime, formatDateTime } from "@/lib/format";
import { statusIcons } from "./status-icons";
import "./source-conversation.css";

type EventEntry = Extract<ConversationEntry, { type: "event" }>;

/** What happened, in the words of the source's own timeline. */
function describeEvent(entry: EventEntry): {
  text: string;
  icon: LucideIcon;
} {
  const actor = entry.actor ?? "Someone";
  const subject = entry.subject;
  switch (entry.event) {
    case "closed":
      switch (entry.state_category) {
        case "completed":
          return {
            text: `${actor} closed this as completed`,
            icon: statusIcons.Done,
          };
        case "not_planned":
          return {
            text: `${actor} closed this as not planned`,
            icon: statusIcons.Canceled,
          };
        case "duplicate":
          return {
            text: `${actor} closed this as a duplicate${subject ? ` of ${subject}` : ""}`,
            icon: statusIcons.Duplicate,
          };
        default:
          return { text: `${actor} closed this`, icon: Circle };
      }
    case "reopened":
      return { text: `${actor} reopened this`, icon: Circle };
    case "state_changed":
      return {
        text: subject
          ? `${actor} moved this to ${subject}`
          : `${actor} changed the workflow state`,
        icon: Circle,
      };
    case "marked_duplicate":
      return {
        text: `${actor} marked this as a duplicate${subject ? ` of ${subject}` : ""}`,
        icon: statusIcons.Duplicate,
      };
    case "unmarked_duplicate":
      return {
        text: `${actor} removed this duplicate link${subject ? ` to ${subject}` : ""}`,
        icon: statusIcons.Duplicate,
      };
    case "duplicate_added":
      return {
        text: `${actor} linked ${subject ?? "an issue"} as a duplicate of this`,
        icon: statusIcons.Duplicate,
      };
    case "duplicate_removed":
      return {
        text: `${actor} removed ${subject ?? "an issue"} as a duplicate of this`,
        icon: statusIcons.Duplicate,
      };
    case "assigned":
      return {
        text:
          !subject || subject === entry.actor
            ? `${actor} self-assigned this`
            : `${actor} assigned ${subject}`,
        icon: UserPlus,
      };
    case "unassigned":
      return {
        text:
          !subject || subject === entry.actor
            ? `${actor} removed themselves as assignee`
            : `${actor} unassigned ${subject}`,
        icon: UserMinus,
      };
    default:
      return { text: `${actor} updated this`, icon: CircleAlert };
  }
}

/**
 * The source's comments and timeline events for a ticket, read-only, joined on
 * one connected timeline like Activity; the Read-only mark on each comment is
 * the provenance signal. Locally authored notes are not shown here and nothing in this
 * section can be edited or composed. Reloading keeps the rows in place, and a
 * failed reload keeps whatever was retrieved before.
 */
export function SourceConversation({
  source,
  reference,
  revision,
  select,
}: {
  source: TicketSource;
  reference: string;
  revision: number;
  select: (reference: string | null) => void;
}) {
  const now = useNow();
  const [entries, setEntries] = useState<ConversationEntry[] | null>(null);
  const [error, setError] = useState<FailureDescription | null>(null);
  const [attempt, setAttempt] = useState(0);
  const refreshedAt = source.last_refreshed_at;
  useEffect(() => {
    let active = true;
    void client
      .sourceConversation(reference)
      .then((result) => {
        if (!active) return;
        setEntries(result);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (active) setError(describeFailure(reason, "load the conversation"));
      });
    return () => {
      active = false;
    };
  }, [reference, revision, refreshedAt, attempt]);
  const name = source.provider_name;
  const owned = source.ownership === "external";
  // Provenance only: after takeover there is nothing to show unless it was retrieved.
  if (!owned && !error && (entries === null || entries.length === 0))
    return null;
  return (
    <section
      className="source-conversation"
      aria-label={`Conversation on ${name}`}
    >
      <SectionHeader
        title={`${name} conversation`}
        actions={
          owned &&
          !source.unavailable && (
            <SourceLink url={source.url}>Comment on {name}</SourceLink>
          )
        }
      >
        <span className="source-caption">
          {owned
            ? `${entries?.filter((entry) => entry.type === "comment").length ?? 0} comments · read-only`
            : "archive · no longer refreshed"}
        </span>
      </SectionHeader>
      {error && (
        <FailureState
          size="inline"
          failure={error}
          onRetry={() => setAttempt((value) => value + 1)}
        />
      )}
      {entries && entries.length === 0 && !error && (
        <EmptyState
          size="inline"
          plain
          description={
            source.unavailable
              ? "No comments in the last synced copy."
              : `No comments on ${name} yet.`
          }
        />
      )}
      {entries && entries.length > 0 && (
        <Timeline aria-label="Conversation">
          {entries.map((entry) =>
            entry.type === "comment" ? (
              <CommentRow
                key={`${entry.type}-${entry.id}`}
                icon={MessageSquare}
                label={`Comment by ${entry.author} on ${name}, read-only`}
                header={
                  <span>
                    <strong>{entry.author}</strong> commented on {name} ·{" "}
                    <Tooltip content={formatDateTime(entry.created_at)}>
                      <time dateTime={entry.created_at} tabIndex={0}>
                        {relativeDateTime(entry.created_at, now)}
                      </time>
                    </Tooltip>
                    {entry.edited_at && (
                      <>
                        {" "}
                        · <span>edited</span>
                      </>
                    )}
                  </span>
                }
                actions={
                  <span className="source-card-actions">
                    <span className="source-readonly-label">
                      <LockKeyhole aria-hidden="true" />
                      Read-only
                    </span>
                    <SourceLink url={entry.url}>View on {name}</SourceLink>
                  </span>
                }
              >
                <div className="markdown-preview description-document">
                  <MarkdownDocument
                    source={entry.body}
                    select={select}
                    revision={revision}
                  />
                </div>
              </CommentRow>
            ) : (
              <SourceEvent
                key={`${entry.type}-${entry.id}`}
                entry={entry}
                name={name}
                now={now}
              />
            ),
          )}
        </Timeline>
      )}
    </section>
  );
}

function SourceEvent({
  entry,
  name,
  now,
}: {
  entry: EventEntry;
  name: string;
  now: number;
}) {
  const { text, icon } = describeEvent(entry);
  return (
    <EventRow
      icon={icon}
      meta={
        <Tooltip content={formatDateTime(entry.created_at)}>
          <time dateTime={entry.created_at} tabIndex={0}>
            {relativeDateTime(entry.created_at, now)}
          </time>
        </Tooltip>
      }
    >
      <strong>{entry.actor ?? "Someone"}</strong>
      {text.slice((entry.actor ?? "Someone").length)} on {name}
    </EventRow>
  );
}
