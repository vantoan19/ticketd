import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { RecordLink } from "@/components/ui/record-link";
import { references } from "./ticket-references";
import { useTicket } from "./open-ticket";

export function TicketReference({
  reference,
  select,
}: {
  reference: string;
  select: (reference: string) => void;
}) {
  // Chips naming the same ticket share one read, which follows every change.
  const target = useTicket(reference).value;
  // A reference opens its ticket; one that cannot be found is plain (P15).
  return target ? (
    <RecordLink reference={reference} onClick={() => select(reference)}>
      {target.trashed ? "(in Trash)" : null}
    </RecordLink>
  ) : (
    <RecordLink reference={reference} gone />
  );
}

export function TicketMarkdown({
  content,
  select,
}: {
  content: string;
  select: ((reference: string) => void) | undefined;
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
            <TicketReference reference={href.slice(8)} select={select} />
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
