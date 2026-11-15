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
  const [error, setError] = useState<FailureDescription | null>(null);
  const [pending, setPending] = useState(false);
  /** The link just removed, so it can be put back. */
  const [removed, setRemoved] = useState<LinkRow | null>(null);
  const attempts = useRef(new Map<string, string>());
  const reference = ticket.reference;

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    client.contextualRelationships(reference, 0).then(
      (links) => {
        if (active) setLoaded({ reference, links, failure: null });
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

  const current = loaded?.reference === reference ? loaded : null;
  const rows: LinkRow[] = current?.links ? linkRows(current.links) : [];
  const more = current?.links ? nextOffset(current.links) : null;
  const retry = useCallback(() => setReload((value) => value + 1), []);

  async function remove(row: LinkRow) {
    const key = JSON.stringify([row.kind, row.reference]);
    const id = attempts.current.get(key) ?? crypto.randomUUID();
    attempts.current.set(key, id);
    setPending(true);
    setError(null);
    try {
      await removeLink(reference, row.kind, row.reference, id);
      attempts.current.delete(key);
      setRemoved(
        row.kind === "duplicate_of" || row.kind === "duplicates" ? null : row,
      );
      setReload((value) => value + 1);
      await refresh();
    } catch (reason) {
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
  async function undoRemove() {
    if (
      !removed ||
      removed.kind === "duplicate_of" ||
      removed.kind === "duplicates"
    )
      return;
    setPending(true);
    setError(null);
    try {
      await addLink(
        reference,
        removed.kind,
        removed.reference,
        crypto.randomUUID(),
      );
      setRemoved(null);
      setReload((value) => value + 1);
      await refresh();
    } catch (reason) {
      setError(describeFailure(reason, "put the link back"));
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
      setError(describeFailure(reason, "load more links"));
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
    removed,
    undoRemove,
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
