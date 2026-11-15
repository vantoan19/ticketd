import { useStatusLine } from "@/components/ui/use-status-line";
import { useCallback, useEffect, useRef, useState } from "react";
import { client, type Relationships, type Ticket } from "@/lib/api/client";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import {
  linkLabel,
  linkRows,
  mergePage,
  nextOffset,
  addLink,
  removeLink,
  type AddableKind,
  type LinkRow,
} from "@/features/tickets/linked-work";

type Loaded = {
  reference: string;
  links: Relationships | null;
  /** Why the read failed, when it did. */
  failure: FailureDescription | null;
};

/**
 * One bounded read of the core's relationships feeds the Subtickets section
 * under the description and the Relationships section of the rail. It reruns
 * whenever the workspace revision moves, so links made elsewhere appear.
 */
export function useLinkedWork(
  ticket: Ticket,
  revision: number,
  refresh: () => Promise<void>,
  enabled = true,
) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [reload, setReload] = useState(0);
  const [linking, setLinking] = useState<AddableKind | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [redirecting, setRedirecting] = useState(false);
  // A failed action, and which kind of row it was on: a subticket's shows under Subtickets, the rest in the rail.
  const [error, setError] = useState<{
    kind: LinkRow["kind"] | null;
    failure: FailureDescription;
  } | null>(null);
  const [pending, setPending] = useState(false);
  // A removal acts at once; the pane's status line offers Undo (P7).
  const statusLine = useStatusLine();
  const attempts = useRef(new Map<string, string>());
  const reference = ticket.reference;

  // Rows removed but not yet re-read: they collapse at once, in place.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    client.contextualRelationships(reference, 0).then(
      (links) => {
        if (active) {
          setLoaded({ reference, links, failure: null });
          // Optimistic hiding lasts only until this authoritative reread.
          // Persistent tombstones would hide a link added again later.
          setHidden(new Set());
        }
      },
      (reason: unknown) => {
        if (active)
          setLoaded((previous) => {
            // Keep what was shown for this ticket; say the refresh failed.
            const links =
              previous?.reference === reference ? previous.links : null;
            return {
              reference,
              links,
              failure: describeFailure(
                reason,
                links ? "refresh relationships" : "load relationships",
              ),
            };
          });
      },
    );
    return () => {
      active = false;
    };
  }, [enabled, reference, revision, reload]);

  // A removal hides a row and the next one slides under the pointer with its
  // × already showing, so clicks on that slot wait out 400ms: a double-click
  // never removes a second relationship.
  const settling = useRef(false);
  const current = loaded?.reference === reference ? loaded : null;
  const rowKey = (row: Pick<LinkRow, "kind" | "reference">) =>
    JSON.stringify([row.kind, row.reference]);
  const rows: LinkRow[] = current?.links
    ? linkRows(current.links).filter((row) => !hidden.has(rowKey(row)))
    : [];
  const more = current?.links ? nextOffset(current.links) : null;
  const retry = useCallback(() => setReload((value) => value + 1), []);
  const show = (key: string, shown: boolean) =>
    setHidden((old) => {
      const next = new Set(old);
      if (shown) next.delete(key);
      else next.add(key);
      return next;
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
      setReload((value) => value + 1);
      await refresh();
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
      setError({
        kind: row.kind,
        failure: describeFailure(
          reason,
          `remove ${linkLabel(row.kind)} ${row.reference}`,
        ),
      });
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
      setReload((value) => value + 1);
      await refresh();
    } finally {
      setPending(false);
    }
  }
  async function showMore() {
    if (!current?.links || more === null) return;
    try {
      const page = await client.contextualRelationships(reference, more);
      setLoaded((previous) =>
        previous?.links && previous.reference === reference
          ? { ...previous, links: mergePage(previous.links, page) }
          : previous,
      );
    } catch (reason) {
      setError({
        kind: null,
        failure: describeFailure(reason, "load more links"),
      });
    }
  }
  return {
    ticket,
    reference,
    current,
    rows,
    more,
    error,
    pending,
    remove,
    showMore,
    retry,
    refresh,
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
