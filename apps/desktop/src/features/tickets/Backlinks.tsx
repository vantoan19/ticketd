import { useContext, useState } from "react";
import { DocumentNavigation } from "@/features/documents/navigation";
import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/ui/disclosure";
import { FailureState } from "@/components/ui/failure-alert";
import { Reference } from "@/components/ui/reference";
import { Tooltip } from "@/components/ui/tooltip";
import { compactAgo, formatDateTime, plural } from "@/lib/format";
import { StatusIcon } from "./StatusIcon";
import { useOpenTicket } from "./open-ticket";
import { plainPassage } from "./plain-passage";
import { EmphasizedPassage } from "./reference-passage";
import { useLinkedGroup } from "./linked-group";
import type { PartState } from "./open-ticket/parts";
import "./backlinks.css";

/** Where a mention was found, so the source ticket can reveal the passage. */
export type MentionTarget = {
  /** Reference of the ticket that contains the mention. */
  reference: string;
  /** Reference of the ticket being mentioned. */
  mentioned: string;
  noteId: string | null;
  passage: string;
  /** Source span of the mention, in Unicode scalar values of the Markdown. */
  start: number;
  end: number;
};

export function Backlinks({
  select,
  mentions,
  documentLinks,
  rail = false,
}: {
  select: (target: MentionTarget) => void;
  mentions: PartState<"backlinks">;
  documentLinks: PartState<"documentBacklinks">;
  rail?: boolean;
}) {
  const { record, reference } = useOpenTicket();
  const openDocument = useContext(DocumentNavigation);
  const [open, setOpen] = useLinkedGroup(record.id, "mentioned_in", false);
  const { value, failure, retry, loadingMore, showMore } = mentions;
  const count = value?.total;
  const documentCount = documentLinks.value?.total;
  const links = value?.items ?? [];
  const documents = documentLinks.value?.items ?? [];
  const total =
    count !== undefined && documentCount !== undefined
      ? count + documentCount
      : undefined;
  if (!failure && !documentLinks.failure && !count && !documentCount)
    return null;
  return (
    <div className="linked-work-disclosure">
      <Disclosure
        label={
          rail && total !== undefined ? (
            plural(total, "mention")
          ) : (
            <>
              Mentioned in{" "}
              {!rail && count !== undefined && (
                <span className="linked-work-note">
                  {plural(count, "ticket")}
                </span>
              )}
            </>
          )
        }
        {...(!rail && total !== undefined && { count: total })}
        open={open}
        onOpenChange={setOpen}
      >
        {Boolean(count) && (
          <p className="linked-work-note">
            Tickets whose text names {reference}, newest first
          </p>
        )}
        {failure && (
          <FailureState size="inline" failure={failure} onRetry={retry} />
        )}
        <ul className="backlink-list">
          {links.map((link) => (
            <MentioningTicket
              key={link.reference}
              link={link}
              select={select}
            />
          ))}
          {documents.map((link) => (
            <li key={`${link.source_id}-${link.passage}`}>
              <button
                type="button"
                className="backlink-source"
                onClick={() => openDocument?.(link.source_id)}
              >
                <span className="backlink-heading">
                  <strong>
                    {link.source_label}
                    {link.source_trashed ? " (Trash)" : ""}
                  </strong>
                  <span className="backlink-where">Document</span>
                </span>
                <span className="mention-passage">
                  <EmphasizedPassage
                    text={plainPassage(link.passage)}
                    reference={reference}
                  />
                </span>
              </button>
            </li>
          ))}
        </ul>
        {mentions.more && count !== undefined && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            busy={loadingMore}
            onClick={showMore}
          >
            Show {Math.min(3, count - links.length)} more
          </Button>
        )}
        {documentLinks.failure && (
          <FailureState
            size="inline"
            failure={documentLinks.failure}
            onRetry={documentLinks.retry}
          />
        )}
        {documentLinks.more &&
          !documentLinks.failedMore &&
          documentCount !== undefined && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              busy={documentLinks.loadingMore}
              onClick={documentLinks.showMore}
            >
              Show {Math.min(3, documentCount - documents.length)} more Document
              mentions
            </Button>
          )}
      </Disclosure>
    </div>
  );
}

type MentionRow = NonNullable<PartState<"backlinks">["value"]>["items"][number];

function MentioningTicket({
  link,
  select,
}: {
  link: MentionRow;
  select: (target: MentionTarget) => void;
}) {
  const { reference } = useOpenTicket();
  const [expanded, setExpanded] = useState(false);
  const extra = useOpenTicket(
    "mentionPassages",
    link.reference,
    expanded ? link.next_offset : null,
  );
  const time = compactAgo(link.mentioned_at);
  const passages = new Map(
    [...link.passages, ...(extra.value ?? [])].map((passage) => [
      `${passage.activity_id ?? "description"}-${passage.mention_start}`,
      passage,
    ]),
  );
  return (
    <li>
      {[...passages].map(([key, passage], index) => (
        <button
          key={key}
          type="button"
          className="backlink-source"
          onClick={() =>
            select({
              reference: link.reference,
              mentioned: reference,
              noteId: passage.activity_id,
              passage: passage.passage,
              start: passage.mention_start,
              end: passage.mention_end,
            })
          }
        >
          {index === 0 && (
            <span className="backlink-heading">
              <span role="img" aria-label={link.status}>
                <StatusIcon status={link.status} size={16} decorative />
              </span>
              <Reference>{link.reference}</Reference>
              <strong>{link.title}</strong>
              {time && (
                <Tooltip content={formatDateTime(link.mentioned_at)}>
                  <time className="backlink-where" dateTime={link.mentioned_at}>
                    {time}
                  </time>
                </Tooltip>
              )}
            </span>
          )}
          <span className="mention-passage">
            <EmphasizedPassage
              text={plainPassage(passage.passage)}
              reference={reference}
            />
          </span>
        </button>
      ))}
      {extra.failure && (
        <FailureState
          size="inline"
          failure={extra.failure}
          onRetry={extra.retry}
        />
      )}
      {link.next_offset !== null &&
        !extra.failure &&
        (!expanded || extra.value === undefined || extra.more) && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            busy={expanded && (extra.value === undefined || extra.loadingMore)}
            onClick={expanded ? extra.showMore : () => setExpanded(true)}
            aria-label={`Show more passages from ${link.reference}`}
          >
            Show more passages
          </Button>
        )}
    </li>
  );
}
