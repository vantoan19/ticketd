import { useContext } from "react";
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
import type { DocumentLink } from "@/features/documents/api";
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
}: {
  select: (target: MentionTarget) => void;
  mentions: PartState<"backlinks">;
  documentLinks: DocumentLink[];
}) {
  const { record, reference } = useOpenTicket();
  const openDocument = useContext(DocumentNavigation);
  const [open, setOpen] = useLinkedGroup(record.id, "mentioned_in", false);
  const { value, failure, retry, loadingMore, showMore } = mentions;
  const count = value?.total ?? 0;
  const links = value?.items ?? [];
  if (!failure && count === 0 && documentLinks.length === 0) return null;
  return (
    <div className="linked-work-disclosure">
      <Disclosure
        label={
          <>
            Mentioned in{" "}
            <span className="linked-work-note">{plural(count, "ticket")}</span>
          </>
        }
        count={count + documentLinks.length}
        open={open}
        onOpenChange={setOpen}
      >
        <p className="linked-work-note">
          Tickets whose text names {reference}, newest first
        </p>
        {failure && (
          <FailureState size="inline" failure={failure} onRetry={retry} />
        )}
        <ul className="backlink-list">
          {links.map((link) => {
            const time = compactAgo(link.mentioned_at);
            return (
              <li key={link.reference}>
                {link.passages.map((passage, index) => (
                  <button
                    key={`${passage.activity_id ?? "description"}-${passage.mention_start}`}
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
                          <StatusIcon
                            status={link.status}
                            size={16}
                            decorative
                          />
                        </span>
                        <Reference>{link.reference}</Reference>
                        <strong>{link.title}</strong>
                        {time && (
                          <Tooltip content={formatDateTime(link.mentioned_at)}>
                            <time
                              className="backlink-where"
                              dateTime={link.mentioned_at}
                            >
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
              </li>
            );
          })}
          {documentLinks.map((link) => (
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
        {mentions.more && (
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
      </Disclosure>
    </div>
  );
}
