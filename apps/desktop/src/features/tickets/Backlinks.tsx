import { useContext, useState } from "react";
import { DocumentNavigation } from "@/features/documents/navigation";
import { Button } from "@/components/ui/button";
import { SectionHeader } from "@/components/ui/section-header";
import { FailureState } from "@/components/ui/failure-alert";
import { useOpenTicket } from "./open-ticket";
import { plainPassage } from "./plain-passage";
import { EmphasizedPassage } from "./reference-passage";
import { formatDateTime } from "@/lib/format";
import "./backlinks.css";
import { Reference } from "@/components/ui/reference";

/** Where a mention was found, so the source ticket can reveal the passage. */
export type MentionTarget = {
  /** Reference of the ticket that contains the mention. */
  reference: string;
  /** Reference of the ticket being mentioned. */
  mentioned: string;
  noteId: string | null;
  passage: string;
  /** Source span of the mention, in UTF-16 code units of the Markdown. */
  start: number;
  end: number;
};

export function Backlinks({
  select,
}: {
  select: (target: MentionTarget) => void;
}) {
  const { reference } = useOpenTicket();
  const openDocument = useContext(DocumentNavigation);
  const [offset, setOffset] = useState(0);
  const {
    links: found,
    dates: noteDates,
    failure: error,
    retry,
  } = useOpenTicket("backlinks", offset);
  const links = found ?? [];
  const documentLinks = useOpenTicket("documentBacklinks");
  if (
    !error &&
    links.length === 0 &&
    documentLinks.length === 0 &&
    offset === 0
  )
    return null;
  return (
    <section className="backlinks" aria-label="Mentioned in">
      <SectionHeader
        title="Mentioned in"
        count={
          offset === 0
            ? links.length < 20
              ? links.length + documentLinks.length
              : "20+"
            : undefined
        }
      />
      {error && <FailureState size="inline" failure={error} onRetry={retry} />}
      <ul className="backlink-list">
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
        {links.map((link, index) => (
          <li
            key={`${link.source_reference}-${link.activity_id ?? "description"}-${index}`}
          >
            <button
              type="button"
              className="backlink-source"
              onClick={() =>
                select({
                  reference: link.source_reference,
                  mentioned: reference,
                  noteId: link.activity_id,
                  passage: link.passage,
                  start: link.mention_start,
                  end: link.mention_end,
                })
              }
            >
              <span className="backlink-heading">
                <Reference>{link.source_reference}</Reference>
                <strong>{link.source_title}</strong>
                <span className="backlink-where">
                  {link.activity_id
                    ? `Update${noteDates[link.activity_id] ? ` · ${formatDateTime(noteDates[link.activity_id] ?? "")}` : ""}`
                    : "Description"}
                </span>
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
      {(offset > 0 || links.length === 20) && (
        <div className="backlink-pages">
          {offset > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setOffset(Math.max(0, offset - 20))}
            >
              Previous backlinks
            </Button>
          )}
          {links.length === 20 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setOffset(offset + 20)}
            >
              More backlinks
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
