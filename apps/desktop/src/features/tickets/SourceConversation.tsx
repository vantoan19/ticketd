import { EmptyState } from "@/components/ui/empty-state";
import { Card, CardHeader } from "@/components/ui/card";
import { EventRow, Timeline } from "@/components/ui/timeline";
import { SectionHeader } from "@/components/ui/section-header";
import { useEffect, useState } from "react";
import {
  CircleAlert,
  CircleCheck,
  LockKeyhole,
  CircleEqual,
  Circle,
  CircleSlash,
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
    case "closed_completed":
      return { text: `${actor} closed this as completed`, icon: CircleCheck };
    case "closed_not_planned":
      return {
        text: `${actor} closed this as not planned`,
        icon: CircleSlash,
      };
    case "closed_duplicate":
      return {
        text: `${actor} closed this as a duplicate${subject ? ` of ${subject}` : ""}`,
        icon: CircleEqual,
      };
    case "closed":
      return { text: `${actor} closed this`, icon: Circle };
    case "reopened":
      return { text: `${actor} reopened this`, icon: Circle };
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
 * The source's comments and timeline events for a ticket, read-only. Comments
 * are source cards (the card is the provenance signal) and events are quiet
 * icon rows; locally authored notes are not shown here and nothing in this
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
  const [error, setError] = useState("");
  const refreshedAt = source.last_refreshed_at;
  useEffect(() => {
    let active = true;
    void client
      .sourceConversation(reference)
      .then((result) => {
        if (!active) return;
        setEntries(result);
        setError("");
      })
      .catch((reason: unknown) => {
        if (active) setError(String(reason));
      });
    return () => {
      active = false;
    };
  }, [reference, revision, refreshedAt]);
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
        divided
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
      {error && <p role="alert">Could not load the conversation: {error}</p>}
      {entries && entries.length === 0 && !error && (
        <EmptyState
          size="inline"
          description={
            source.unavailable
              ? "No comments in the last synced copy."
              : `No comments on ${name} yet.`
          }
        />
      )}
      {entries && entries.length > 0 && (
        <Timeline plain aria-label="Conversation">
          {entries.map((entry) =>
            entry.type === "comment" ? (
              <li key={`${entry.type}-${entry.id}`}>
                <Card asChild>
                  <article
                    aria-label={`Comment by ${entry.author} on ${name}, read-only`}
                  >
                    <CardHeader>
                      <span className="source-comment-meta">
                        <strong>{entry.author}</strong> commented on {name} ·{" "}
                        <time
                          dateTime={entry.created_at}
                          title={formatDateTime(entry.created_at)}
                        >
                          {relativeDateTime(entry.created_at, now)}
                        </time>
                        {entry.edited_at && (
                          <>
                            {" "}
                            · <span>edited</span>
                          </>
                        )}
                      </span>
                      <span className="source-card-actions">
                        <span className="source-readonly-label">
                          <LockKeyhole aria-hidden="true" />
                          Read-only
                        </span>
                        <SourceLink url={entry.url}>View on {name}</SourceLink>
                      </span>
                    </CardHeader>
                    <div className="markdown-preview description-document">
                      <MarkdownDocument
                        source={entry.body}
                        select={select}
                        revision={revision}
                      />
                    </div>
                  </article>
                </Card>
              </li>
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
        <time
          dateTime={entry.created_at}
          title={formatDateTime(entry.created_at)}
        >
          {relativeDateTime(entry.created_at, now)}
        </time>
      }
    >
      <strong>{entry.actor ?? "Someone"}</strong>
      {text.slice((entry.actor ?? "Someone").length)} on {name}
    </EventRow>
  );
}
