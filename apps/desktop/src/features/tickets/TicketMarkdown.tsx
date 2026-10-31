import { useEffect, useState } from "react";
import { client } from "@/lib/api/client";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { visit } from "unist-util-visit";
import type { Root, PhrasingContent } from "mdast";

function references() {
  return (tree: Root) => {
    visit(tree, "text", (node, index, parent) => {
      if (
        index === undefined ||
        !parent ||
        parent.type === "link" ||
        parent.type === "linkReference"
      )
        return;
      const matches = [
        ...node.value.matchAll(
          /(?<![\p{L}\p{N}_-])T-[1-9]\d*(?![\p{L}\p{N}_-])/gu,
        ),
      ];
      if (!matches.length) return;
      const parts: PhrasingContent[] = [];
      let last = 0;
      for (const match of matches) {
        if (match.index > last)
          parts.push({
            type: "text",
            value: node.value.slice(last, match.index),
          });
        parts.push({
          type: "link",
          url: `ticketd:${match[0]}`,
          children: [{ type: "text", value: match[0] }],
        });
        last = match.index + match[0].length;
      }
      if (last < node.value.length)
        parts.push({ type: "text", value: node.value.slice(last) });
      parent.children.splice(index, 1, ...parts);
      return index + parts.length;
    });
  };
}

function TicketReference({
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
