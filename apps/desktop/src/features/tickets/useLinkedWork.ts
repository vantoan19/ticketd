import { useStatusLine } from "@/components/ui/use-status-line";
import { useRef, useState } from "react";
import type { Relationships, Ticket } from "@/lib/api/client";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import {
  linkLabel,
  linkRows,
  addLink,
  removeLink,
  type AddableKind,
  type LinkRow,
} from "@/features/tickets/linked-work";
import { useOpenTicket } from "@/features/tickets/open-ticket";

type Loaded = {
  reference: string;
  links: Relationships | null;
  /** Why the read failed, when it did. */
  failure: FailureDescription | null;
};

/**
 * Linked and the context line share the Open Ticket's relationship read.
 * The Open Ticket re-reads on workspace changes and after these writes.
 */
export function useLinkedWork() {
  const { record: ticket, changed } = useOpenTicket();
  const read = useOpenTicket("linkedWork");
  const [linking, setLinking] = useState<AddableKind | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [redirecting, setRedirecting] = useState(false);
  const [error, setError] = useState<FailureDescription | null>(null);
  const [pending, setPending] = useState(false);
  // A removal acts at once; the pane's status line offers Undo (P7).
  const statusLine = useStatusLine();
  const attempts = useRef(new Map<string, string>());
  const reference = ticket.reference;
  const links = read.value ?? null;

  // Rows removed but not yet re-read: they collapse at once, in place. They
  // belong to the links they were hidden from, so the next authoritative
  // read (new links) brings them back unless it no longer has them. Persistent
  // tombstones would hide a link added again later.
  const [hiding, setHiding] = useState<{
    from: Relationships | null;
    keys: ReadonlySet<string>;
  }>({ from: null, keys: new Set() });
  const hidden = hiding.from === links ? hiding.keys : new Set<string>();

  // A removal hides a row and the next one slides under the pointer with its
  // × already showing, so clicks on that slot wait out 400ms: a double-click
  // never removes a second relationship.
  const settling = useRef(false);
  const current: Loaded | null =
    links || read.failure ? { reference, links, failure: read.failure } : null;
  const rowKey = (row: Pick<LinkRow, "kind" | "reference">) =>
    JSON.stringify([row.kind, row.reference]);
  const rows: LinkRow[] = links
    ? linkRows(links).filter((row) => !hidden.has(rowKey(row)))
    : [];
  const more = read.more;
  const retry = read.retry;
  const show = (key: string, shown: boolean) =>
    setHiding((old) => {
      const keys = new Set(old.from === links ? old.keys : []);
      if (shown) keys.delete(key);
      else keys.add(key);
      return { from: links, keys };
    });

  async function remove(row: LinkRow) {
    if (settling.current) return;
    settling.current = true;
    window.setTimeout(() => {
      settling.current = false;
    }, 400);
    statusLine.dismiss();
    const key = rowKey(row);
    const id = attempts.current.get(key) ?? crypto.randomUUID();
    attempts.current.set(key, id);
    setPending(true);
    setError(null);
    show(key, false);
    try {
      await removeLink(reference, row.kind, row.reference, id);
      attempts.current.delete(key);
      await changed();
      const kind = row.kind;
      // A duplicate link is undone through its own review, not by Undo.
      if (kind === "duplicate_of" || kind === "duplicates")
        statusLine.show({
          message: `Removed the duplicate link to ${row.reference}`,
          action: {
            label: "Review dependencies",
            run: () => setReviewing(true),
          },
        });
      else
        statusLine.show({
          message: `Removed ${row.reference} from ${linkLabel(kind)}`,
          undo: () => putBack(kind, row.reference),
        });
    } catch (reason) {
      show(key, true);
      setError(
        describeFailure(
          reason,
          `remove ${linkLabel(row.kind)} ${row.reference}`,
        ),
      );
    } finally {
      setPending(false);
    }
  }
  /** Undo for a removal: adds the link back, or throws so the line can say why. */
  async function putBack(kind: AddableKind, target: string) {
    setPending(true);
    try {
      await addLink(reference, kind, target, crypto.randomUUID());
      show(rowKey({ kind, reference: target }), true);
      await changed();
    } finally {
      setPending(false);
    }
  }
  return {
    ticket,
    reference,
    current,
    rows,
    more,
    error,
    loadingMore: read.loadingMore,
    moreFailure: read.moreFailure,
    pending,
    remove,
    showMore: read.showMore,
    retry,
    changed,
    linking,
    openLink: (kind: AddableKind = "related") => setLinking(kind),
    closeLink: () => setLinking(null),
    reviewing,
    setReviewing,
    redirecting,
    setRedirecting,
  };
}

export type LinkedWorkState = ReturnType<typeof useLinkedWork>;

export function orderBlockers(work: LinkedWorkState) {
  const prerequisites = work.current?.links?.prerequisites;
  if (!prerequisites)
    return [...work.ticket.prerequisites].sort(
      (a, b) => Number(b.unresolved) - Number(a.unresolved),
    );
  const rows: Ticket["prerequisites"] = work.rows.filter(
    (row) => row.kind === "blocked_by",
  );
  if (prerequisites.next_offset !== null) {
    // The ticket record already contains all blockers; the paged links hold
    // the newer values and optimistic removals for the rows they have read.
    const loaded = new Set(prerequisites.items.map((row) => row.reference));
    rows.push(
      ...work.ticket.prerequisites.filter((row) => !loaded.has(row.reference)),
    );
  }
  return rows.sort((a, b) => Number(b.unresolved) - Number(a.unresolved));
}
