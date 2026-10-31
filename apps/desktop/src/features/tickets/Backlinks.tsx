import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { client } from "@/lib/api/client";
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
};

export function Backlinks({
  reference,
  revision,
  select,
}: {
  reference: string;
  revision: number;
  select: (target: MentionTarget) => void;
}) {
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
            link.note_id
              ? [
                  client
                    .note(link.source_reference, link.note_id)
                    .then((note) => [link.note_id, note?.created_at] as const)
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
  if (!error && links.length === 0 && offset === 0) return null;
  return (
    <section className="backlinks" aria-label="Mentioned in">
      <h3>
        Mentioned in{" "}
        <span className="text-muted-foreground">
          {offset === 0 ? (links.length < 20 ? links.length : "20+") : ""}
        </span>
      </h3>
      {error && <p role="alert">{error}</p>}
      <ul className="backlink-list">
        {links.map((link, index) => (
          <li
            key={`${link.source_reference}-${link.note_id ?? "description"}-${index}`}
          >
            <button
              type="button"
              className="backlink-source"
              onClick={() =>
                select({
                  reference: link.source_reference,
                  mentioned: reference,
                  noteId: link.note_id,
                  passage: link.passage,
                })
              }
            >
              <span className="backlink-heading">
                <strong>{link.source_reference}</strong>
                <span>{link.source_title}</span>
              </span>
              <span className="backlink-where">
                {link.note_id
                  ? `Note${noteDates[link.note_id] ? ` · ${formatDateTime(noteDates[link.note_id] ?? "")}` : ""}`
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
