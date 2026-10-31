import { useEffect, useState } from "react";
import { client } from "@/lib/api/client";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { references } from "./ticket-references";

export function TicketReference({
  reference,
  select,
  revision,
}: {
  reference: string;
  select: (reference: string) => void;
  revision: number | undefined;
}) {
  const [target, setTarget] = useState<{ trashed: boolean } | null>(null);
  useEffect(() => {
    let active = true;
    void client.showTicket(reference).then(
      (ticket) => {
        if (active) setTarget(ticket);
      },
      () => {
        if (active) setTarget(null);
      },
    );
    return () => {
      active = false;
    };
  }, [reference, revision]);
  return target ? (
    <button
      type="button"
      className="underline"
      onClick={() => select(reference)}
    >
      {reference}
      {target.trashed ? " (trashed)" : ""}
    </button>
  ) : (
    <>{reference}</>
  );
}

export function TicketMarkdown({
  content,
  select,
  revision,
}: {
  content: string;
  select: ((reference: string) => void) | undefined;
  revision?: number | undefined;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, references]}
      urlTransform={(url) =>
        url.startsWith("ticketd:") ? url : defaultUrlTransform(url)
      }
      components={{
        a: ({ href, children, ...props }) =>
          href?.startsWith("ticketd:") && select ? (
            <TicketReference
              reference={href.slice(8)}
              select={select}
              revision={revision}
            />
          ) : (
            <a href={href} {...props}>
              {children}
            </a>
          ),
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
