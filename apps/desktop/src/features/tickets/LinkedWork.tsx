import { useEffect, useRef, useState } from "react";
import { Network, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { client, type Ticket } from "@/lib/api/client";
import { LinkTicketDialog } from "@/features/tickets/LinkTicketDialog";
import { StatusIcon } from "@/features/tickets/StatusIcon";
import {
  linkKinds,
  linkLabel,
  linkSignature,
  removeLink,
  type LinkKind,
  type LinkRow,
} from "@/features/tickets/linked-work";
import "./linked-work.css";

type Contextual = Awaited<ReturnType<typeof client.contextualRelationships>>;
type Info = { title: string; status: string; trashed: boolean };
type Loaded = {
  reference: string;
  contextual: Contextual | null;
  nextOffset: number | null;
  blocks: LinkRow[];
  info: Record<string, Info>;
  failed: boolean;
};

const contextualKinds = [
  ["related", "related"],
  ["discovered_while", "discovered_while"],
  ["discoveries", "discoveries"],
] as const;

function nextOffset(links: Contextual) {
  const offsets = [
    links.related.next_offset,
    links.discovered_while.next_offset,
    links.discoveries.next_offset,
  ].filter((value): value is number => value !== null);
  return offsets.length ? Math.max(...offsets) : null;
}

/** Every link of a ticket as one flat section, grouped by meaning. */
export function LinkedWork({
  ticket,
  revision,
  refresh,
  select,
  onOpenGraph,
}: {
  ticket: Ticket;
  revision: number;
  refresh: () => Promise<void>;
  select: (reference: string) => void;
  onOpenGraph: () => void;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [reload, setReload] = useState(0);
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const attempts = useRef(new Map<string, string>());
  const signature = linkSignature(ticket);
  const reference = ticket.reference;

  useEffect(() => {
    let active = true;
    const refs = [
      ticket.parent?.reference,
      ...ticket.children.map((item) => item.reference),
      ticket.duplicate_of,
      ...(ticket.duplicates ?? []),
    ].filter((value): value is string => !!value);
    void Promise.allSettled([
      client.contextualRelationships(reference, 0),
      client.dependencyGraph(reference),
      ...refs.map((value) => client.showTicket(value)),
    ]).then(([contextual, graphResult, ...tickets]) => {
      if (!active) return;
      const info: Record<string, Info> = {};
      for (const result of tickets)
        if (result.status === "fulfilled")
          info[result.value.reference] = {
            title: result.value.title,
            status: result.value.status,
            trashed: result.value.trashed,
          };
      const blocks: LinkRow[] = [];
      if (graphResult.status === "fulfilled") {
        const nodes = new Map(
          graphResult.value.nodes.map((node) => [node.reference, node]),
        );
        for (const edge of graphResult.value.edges) {
          const node = nodes.get(edge.dependent);
          if (edge.blocker === reference && node)
            blocks.push({
              kind: "blocks",
              reference: node.reference,
              title: node.title,
              status: node.status,
              trashed: node.trashed,
            });
        }
      }
      setLoaded({
        reference,
        contextual: contextual.status === "fulfilled" ? contextual.value : null,
        nextOffset:
          contextual.status === "fulfilled"
            ? nextOffset(contextual.value)
            : null,
        blocks,
        info,
        failed:
          contextual.status === "rejected" || graphResult.status === "rejected",
      });
    });
    return () => {
      active = false;
    };
    // `signature` stands for the link fields of `ticket` read above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reference, revision, signature, reload]);

  const current = loaded?.reference === reference ? loaded : null;
  const rows = collectRows(ticket, current);
  const count = rows.length;

  async function remove(row: LinkRow) {
    const key = JSON.stringify([row.kind, row.reference]);
    const id = attempts.current.get(key) ?? crypto.randomUUID();
    attempts.current.set(key, id);
    setPending(true);
    setError("");
    try {
      await removeLink(reference, row.kind, row.reference, id);
      attempts.current.delete(key);
      setReload((value) => value + 1);
      await refresh();
    } catch (reason) {
      setError(
        `Could not remove ${linkLabel(row.kind)} ${row.reference}: ${String(reason)}`,
      );
    } finally {
      setPending(false);
    }
  }
  async function more() {
    if (!current?.contextual || current.nextOffset === null) return;
    try {
      const page = await client.contextualRelationships(
        reference,
        current.nextOffset,
      );
      setLoaded((previous) => {
        if (!previous?.contextual || previous.reference !== reference)
          return previous;
        const merged = { ...previous.contextual };
        for (const [key] of contextualKinds) {
          const known = new Set(
            merged[key].items.map((item) => item.reference),
          );
          merged[key] = {
            items: [
              ...merged[key].items,
              ...page[key].items.filter((item) => !known.has(item.reference)),
            ],
            next_offset: page[key].next_offset,
          };
        }
        return {
          ...previous,
          contextual: merged,
          nextOffset: nextOffset(page),
        };
      });
    } catch (reason) {
      setError(`Could not load more links: ${String(reason)}`);
    }
  }

  const dialog = (
    <LinkTicketDialog
      ticket={ticket}
      open={linking}
      onOpenChange={setLinking}
      onLinked={async () => {
        setReload((value) => value + 1);
        await refresh();
      }}
    />
  );
  if (count === 0)
    return (
      <section
        id={`linked-work-${reference}`}
        className="linked-work"
        data-empty
        aria-label="Linked work"
      >
        <Button variant="ghost" size="sm" onClick={() => setLinking(true)}>
          <Plus aria-hidden="true" />
          Link ticket
        </Button>
        {error && <p role="alert">{error}</p>}
        {dialog}
      </section>
    );
  return (
    <section
      id={`linked-work-${reference}`}
      className="linked-work"
      aria-label="Linked work"
    >
      <div className="detail-section-heading">
        <h3>
          Linked work <span className="linked-work-count">{count}</span>
        </h3>
        <div className="linked-work-actions">
          <Button variant="ghost" size="sm" onClick={onOpenGraph}>
            <Network aria-hidden="true" />
            Graph
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setLinking(true)}>
            <Plus aria-hidden="true" />
            Link ticket
          </Button>
        </div>
      </div>
      {error && <p role="alert">{error}</p>}
      {current?.failed && (
        <p role="alert">Some linked work could not be loaded.</p>
      )}
      <ul className="linked-work-rows">
        {rows.map((row) => (
          <li
            key={`${row.kind}-${row.reference}`}
            className="linked-work-row"
            data-kind={row.kind}
          >
            <span className="linked-work-label">{linkLabel(row.kind)}</span>
            <StatusIcon
              status={row.status ?? ""}
              size={14}
              decorative
              className="linked-work-icon"
            />
            <span className="linked-work-reference">{row.reference}</span>
            <Button
              variant="link"
              className="linked-work-title"
              onClick={() => select(row.reference)}
            >
              {row.title || "Loading title…"}
            </Button>
            <span className="linked-work-status">{statusText(row)}</span>
            <Button
              variant="ghost"
              size="icon-xs"
              className="linked-work-remove"
              title="Remove relationship"
              aria-label={`Remove relationship: ${linkLabel(row.kind)} ${row.reference}`}
              disabled={pending}
              onClick={() => void remove(row)}
            >
              <X aria-hidden="true" />
            </Button>
          </li>
        ))}
      </ul>
      {current?.nextOffset != null && (
        <Button variant="outline" size="sm" onClick={() => void more()}>
          Show more links
        </Button>
      )}
      {dialog}
    </section>
  );
}

function statusText(row: LinkRow) {
  const parts = [row.status ?? "Loading status…"];
  if (row.kind === "blocked_by" && row.status && row.status !== "Done")
    parts.push("not done");
  if (row.trashed) parts.push("in trash");
  return parts.join(" · ");
}

function collectRows(ticket: Ticket, loaded: Loaded | null): LinkRow[] {
  const info = loaded?.info ?? {};
  const known = (
    kind: LinkKind,
    reference: string,
    title: string | undefined,
    trashed: boolean | undefined,
  ): LinkRow => ({
    kind,
    reference,
    title: info[reference]?.title ?? title ?? "",
    status: info[reference]?.status ?? null,
    trashed: info[reference]?.trashed ?? trashed ?? false,
  });
  const byKind: Record<LinkKind, LinkRow[]> = {
    blocked_by: ticket.prerequisites.map((item) => ({
      kind: "blocked_by",
      ...item,
    })),
    blocks: loaded?.blocks ?? [],
    parent: ticket.parent
      ? [
          known(
            "parent",
            ticket.parent.reference,
            ticket.parent.title,
            ticket.parent.trashed,
          ),
        ]
      : [],
    subticket: ticket.children.map((item) =>
      known("subticket", item.reference, item.title, item.trashed),
    ),
    related: [],
    discovered_while: [],
    discoveries: [],
    duplicate_of: ticket.duplicate_of
      ? [known("duplicate_of", ticket.duplicate_of, undefined, undefined)]
      : [],
    duplicates: (ticket.duplicates ?? []).map((reference) =>
      known("duplicates", reference, undefined, undefined),
    ),
  };
  if (loaded?.contextual)
    for (const [key, kind] of contextualKinds)
      byKind[kind] = loaded.contextual[key].items.map((item) => ({
        kind,
        reference: item.reference,
        title: item.title.text,
        status: item.status,
        trashed: item.trashed,
      }));
  return linkKinds.flatMap(({ kind }) => byKind[kind]);
}
