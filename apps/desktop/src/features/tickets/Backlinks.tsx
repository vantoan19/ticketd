import { useEffect, useState } from "react";
import { client } from "@/lib/api/client";

type Link = Awaited<ReturnType<typeof client.backlinks>>[number];
export function Backlinks({
  reference,
  revision,
  select,
}: {
  reference: string;
  revision: number;
  select: (reference: string) => void;
}) {
  const [links, setLinks] = useState<Link[]>([]);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void client.backlinks(reference, offset).then(
      (result) => {
        if (active) {
          setLinks(result);
          setError("");
        }
      },
      (reason: unknown) => {
        if (active) setError(String(reason));
      },
    );
    return () => {
      active = false;
    };
  }, [reference, revision, offset]);
  return (
    <details className="detail-disclosure">
      <summary>Backlinks</summary>
      {error && <p role="alert">{error}</p>}
      {!error && links.length === 0 && <p>No backlinks.</p>}
      <ul>
        {links.map((link, index) => (
          <li
            key={`${link.source_reference}-${link.note_id ?? "description"}-${index}`}
          >
            <button
              type="button"
              className="underline"
              onClick={() => select(link.source_reference)}
            >
              {link.source_reference} · {link.source_title}
            </button>{" "}
            {link.note_id ? "Note" : "Description"}
            <p>{link.passage}</p>
          </li>
        ))}
      </ul>
      {offset > 0 && (
        <button
          type="button"
          onClick={() => setOffset(Math.max(0, offset - 20))}
        >
          Previous backlinks
        </button>
      )}
      {links.length === 20 && (
        <button type="button" onClick={() => setOffset(offset + 20)}>
          More backlinks
        </button>
      )}
    </details>
  );
}
