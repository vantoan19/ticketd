import { useEffect, useState } from "react";
import {
  CircleAlert,
  CircleCheck,
  CircleDot,
  CircleEqual,
  CircleHelp,
  CircleSlash,
  UserMinus,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import { MarkdownDocument } from "@/features/markdown/MarkdownDocument";
import { SourceLink } from "@/features/tickets/SourceLink";
import { providerName } from "@/features/tickets/ticket-source";
import { client } from "@/lib/api/client";
import type { ConversationEntry, TicketSource } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";
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
        text: `${actor} closed this as a duplicate`,
        icon: CircleEqual,
      };
    case "closed":
      return { text: `${actor} closed this`, icon: CircleHelp };
    case "reopened":
      return { text: `${actor} reopened this`, icon: CircleDot };
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
  const name = providerName(source.provider);
  const owned = source.ownership === "external";
  // Provenance only: after takeover there is nothing to show unless it was retrieved.
  if (!owned && !error && (entries === null || entries.length === 0))
    return null;
  return (
    <section
      className="source-conversation"
      aria-label={`Conversation on ${name}`}
    >
      <h3>Conversation on {name}</h3>
      {error && <p role="alert">Could not load the conversation: {error}</p>}
      {entries && entries.length === 0 && !error && (
        <p className="source-caption">No comments on {name} yet.</p>
      )}
      {entries && entries.length > 0 && (
        <ol className="source-conversation-list">
          {entries.map((entry) => (
            <li key={`${entry.type}-${entry.id}`}>
              {entry.type === "comment" ? (
                <article
                  className="source-card"
                  aria-label={`Comment by ${entry.author} on ${name}, read-only`}
                >
                  <header className="source-card-header">
                    <span>
                      <strong>{entry.author}</strong> commented ·{" "}
                      <time dateTime={entry.created_at}>
                        {formatDateTime(entry.created_at)}
                      </time>
                      {entry.edited_at && (
                        <>
                          {" "}
                          · <span>edited</span>
                        </>
                      )}
                    </span>
                    <span className="source-card-actions">
                      <span>Read-only</span>
                      <SourceLink url={entry.url}>View on {name}</SourceLink>
                    </span>
                  </header>
                  <div className="markdown-preview description-document">
                    <MarkdownDocument
                      source={entry.body}
                      select={select}
                      revision={revision}
                    />
                  </div>
                </article>
              ) : (
                <EventRow entry={entry} />
              )}
            </li>
          ))}
        </ol>
      )}
      {owned && (
        <p className="source-caption">
          Comments are read-only here.{" "}
          <SourceLink url={source.url}>Comment on {name}</SourceLink>
        </p>
      )}
    </section>
  );
}

function EventRow({ entry }: { entry: EventEntry }) {
  const { text, icon: Icon } = describeEvent(entry);
  return (
    <div className="source-event">
      <span className="source-event-icon" aria-hidden="true">
        <Icon size={14} />
      </span>
      <span className="source-event-text">{text}</span>
      <time dateTime={entry.created_at}>
        {formatDateTime(entry.created_at)}
      </time>
    </div>
  );
}
