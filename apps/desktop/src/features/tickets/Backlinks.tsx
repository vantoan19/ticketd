import { useContext, useEffect, useState } from "react";
import { DocumentNavigation } from "@/features/documents/navigation";
import { documents } from "@/features/documents/api";
import { Button } from "@/components/ui/button";
import { client } from "@/lib/api/client";
import { plainPassage } from "./plain-passage";
import { EmphasizedPassage } from "./reference-passage";
import { formatDateTime } from "@/lib/format";
import "./backlinks.css";

type Link = Awaited<ReturnType<typeof client.backlinks>>[number];

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
  reference,
  ticketId,
  revision,
  select,
}: {
  reference: string;
  ticketId?: string;
  revision: number;
  select: (target: MentionTarget) => void;
}) {
  const openDocument = useContext(DocumentNavigation);
  const [documentLinks, setDocumentLinks] = useState<
    Awaited<ReturnType<typeof documents.links>>[1]
  >([]);
  const [links, setLinks] = useState<Link[]>([]);
  const [noteDates, setNoteDates] = useState<Record<string, string>>({});
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void client
      .backlinks(reference, offset)
      .then(async (result) => {
        if (!active) return;
        setLinks(result);
        setError("");
        // The mention itself carries no date, so read each note's.
        const dated = await Promise.all(
          result.flatMap((link) =>
            link.activity_id
              ? [
                  client
                    .activity(link.source_reference, link.activity_id)
                    .then(
                      (note) => [link.activity_id, note?.reported_at] as const,
                    )
                    .catch(() => null),
                ]
              : [],
          ),
        );
        if (!active) return;
        setNoteDates(
          Object.fromEntries(
            dated.flatMap((entry) =>
              entry?.[0] && entry[1] ? [[entry[0], entry[1]]] : [],
            ),
          ),
        );
      })
      .catch((reason: unknown) => {
        if (active) setError(String(reason));
      });
    return () => {
      active = false;
    };
  }, [reference, revision, offset]);
  useEffect(() => {
    let active = true;
    if (!ticketId)
      return () => {
        active = false;
      };
    // Incoming links mix tickets, Plans and Documents; page through them so
    // Document mentions past the first 100 links are not lost.
    void (async () => {
      const found: typeof documentLinks = [];
      for (let page = 0; page < 5; page += 1) {
        const [, incoming] = await documents.links(ticketId, page * 100);
        found.push(
          ...incoming.filter((link) => link.source_kind === "document"),
        );
        if (incoming.length < 100) break;
      }
      if (active) setDocumentLinks(found);
    })().catch(() => {});
    return () => {
      active = false;
    };
  }, [ticketId, revision]);
  if (
    !error &&
    links.length === 0 &&
    documentLinks.length === 0 &&
    offset === 0
  )
    return null;
  return (
    <section className="backlinks" aria-label="Mentioned in">
      <h3>
        Mentioned in{" "}
        <span className="text-muted-foreground">
          {offset === 0
            ? links.length < 20
              ? links.length + documentLinks.length
              : "20+"
            : ""}
        </span>
      </h3>
      {error && <p role="alert">{error}</p>}
      <ul className="backlink-list">
        {documentLinks.map((link) => (
          <li key={`${link.source_id}-${link.passage}`}>
            <button
              type="button"
              className="backlink-source"
              onClick={() => openDocument?.(link.source_id)}
            >
              <strong>
                {link.source_label}
                {link.source_trashed ? " (Trash)" : ""}
              </strong>
              <span>{plainPassage(link.passage)}</span>
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
                <strong>{link.source_reference}</strong>
                <span>{link.source_title}</span>
              </span>
              <span className="backlink-where">
                {link.activity_id
                  ? `Update${noteDates[link.activity_id] ? ` · ${formatDateTime(noteDates[link.activity_id] ?? "")}` : ""}`
                  : "Description"}
              </span>
              <span className="mention-passage">
                <EmphasizedPassage text={link.passage} reference={reference} />
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
