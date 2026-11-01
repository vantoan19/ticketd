import { useEffect, useRef, useState } from "react";
import { Network, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { client, type Relationships, type Ticket } from "@/lib/api/client";
import { Duplicates } from "@/features/tickets/Duplicates";
import { LinkTicketDialog } from "@/features/tickets/LinkTicketDialog";
import { StatusIcon } from "@/features/tickets/StatusIcon";
import {
  linkLabel,
  linkRows,
  mergePage,
  nextOffset,
  removeLink,
  type LinkRow,
} from "@/features/tickets/linked-work";
import "./linked-work.css";

type Loaded = {
  reference: string;
  links: Relationships | null;
  /** Why the read failed, when it did. */
  failure: string;
};

const isDuplicateKind = (kind: LinkRow["kind"]) =>
  kind === "duplicate_of" || kind === "duplicates";

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
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const attempts = useRef(new Map<string, string>());
  const reference = ticket.reference;

  // One bounded read of the core's relationships feeds every row. It reruns
  // whenever the workspace changes, so links made elsewhere appear.
  useEffect(() => {
    let active = true;
    client.contextualRelationships(reference, 0).then(
      (links) => {
        if (active) setLoaded({ reference, links, failure: "" });
      },
      (reason: unknown) => {
        if (active)
          setLoaded((previous) => ({
            reference,
            // Keep what was shown for this ticket; say the refresh failed.
            links: previous?.reference === reference ? previous.links : null,
            failure: String(reason),
          }));
      },
    );
    return () => {
      active = false;
    };
  }, [reference, revision, reload]);

  const current = loaded?.reference === reference ? loaded : null;
  const rows = current?.links ? linkRows(current.links) : [];
  const more = current?.links ? nextOffset(current.links) : null;

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
      setError(`Could not load more links: ${String(reason)}`);
    }
  }

  const dialogs = (
    <>
      <LinkTicketDialog
        ticket={ticket}
        open={linking}
        onOpenChange={setLinking}
        onLinked={async () => {
          setReload((value) => value + 1);
          await refresh();
        }}
      />
      <Dialog open={reviewing} onOpenChange={setReviewing}>
        <DialogContent className="duplicate-dialog">
          <DialogHeader>
            <DialogTitle>Review dependency changes</DialogTitle>
            <DialogDescription>
              Move dependencies between {ticket.reference} and another ticket
              after a duplicate link was removed.
            </DialogDescription>
          </DialogHeader>
          <Duplicates
            ticket={ticket}
            startSeparate
            refresh={async () => {
              setReload((value) => value + 1);
              await refresh();
            }}
            onDone={() => setReviewing(false)}
            onCancel={() => setReviewing(false)}
          />
        </DialogContent>
      </Dialog>
    </>
  );
  const linkAction = (
    <Button variant="ghost" size="sm" onClick={() => setLinking(true)}>
      <Plus aria-hidden="true" />
      Link ticket
    </Button>
  );
  // Collapse to the bare action only after a successful read found nothing;
  // loading and failed look different from "no links".
  if (!current?.links || rows.length === 0)
    return (
      <section
        id={`linked-work-${reference}`}
        className="linked-work"
        data-empty
        aria-label="Linked work"
      >
        {linkAction}
        {!current && (
          <span className="linked-work-state" role="status">
            Loading linked work…
          </span>
        )}
        {current && !current.links && (
          <span className="linked-work-state" role="alert">
            Could not load linked work: {current.failure}{" "}
            <Button
              variant="link"
              size="xs"
              onClick={() => setReload((value) => value + 1)}
            >
              Try again
            </Button>
          </span>
        )}
        {error && <p role="alert">{error}</p>}
        {dialogs}
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
          Linked work{" "}
          <span className="linked-work-count">
            {rows.length}
            {more !== null && "+"}
          </span>
        </h3>
        <div className="linked-work-actions">
          <Button variant="ghost" size="sm" onClick={onOpenGraph}>
            <Network aria-hidden="true" />
            Graph
          </Button>
          {linkAction}
        </div>
      </div>
      {error && <p role="alert">{error}</p>}
      {current.failure && (
        <p role="alert">
          Linked work could not be refreshed: {current.failure}
        </p>
      )}
      <ul className="linked-work-rows">
        {rows.map((row, index) => (
          <li
            key={`${row.kind}-${row.reference}`}
            className="linked-work-row"
            data-kind={row.kind}
          >
            {/* Rows of one kind read as a group: only the first shows its
                label, and screen readers still hear it on every row. */}
            <span
              className="linked-work-label"
              data-repeat={rows[index - 1]?.kind === row.kind || undefined}
            >
              {linkLabel(row.kind)}
            </span>
            <StatusIcon
              status={row.status}
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
              {row.title}
            </Button>
            <span className="linked-work-status">{statusText(row)}</span>
            {isDuplicateKind(row.kind) ? (
              <RemoveDuplicate
                row={row}
                ticket={reference}
                disabled={pending}
                onRemove={() => void remove(row)}
                onReview={() => setReviewing(true)}
              />
            ) : (
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
            )}
          </li>
        ))}
      </ul>
      {more !== null && (
        <Button variant="outline" size="sm" onClick={() => void showMore()}>
          Show more links
        </Button>
      )}
      {dialogs}
    </section>
  );
}

/**
 * Removing a duplicate link is not a plain delete: it restores the duplicate's
 * earlier status and leaves moved dependencies where they are. The person sees
 * that before confirming.
 */
function RemoveDuplicate({
  row,
  ticket,
  disabled,
  onRemove,
  onReview,
}: {
  row: LinkRow;
  ticket: string;
  disabled: boolean;
  onRemove: () => void;
  onReview: () => void;
}) {
  const [open, setOpen] = useState(false);
  const duplicate = row.kind === "duplicate_of" ? ticket : row.reference;
  const canonical = row.kind === "duplicate_of" ? row.reference : ticket;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          className="linked-work-remove"
          title="Remove relationship"
          aria-label={`Remove relationship: ${linkLabel(row.kind)} ${row.reference}`}
          disabled={disabled}
        >
          <X aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label="Remove duplicate link"
        className="linked-work-confirm"
      >
        <p>
          {duplicate} stops being a duplicate of {canonical} and returns to the
          status it had before. Dependencies that were moved to {canonical} stay
          where they are; review them separately.
        </p>
        <div className="linked-work-confirm-actions">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setOpen(false);
              onReview();
            }}
          >
            Review separate dependency changes
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setOpen(false);
              onRemove();
            }}
          >
            Remove duplicate link
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function statusText(row: LinkRow) {
  const parts = [row.status];
  if (row.kind === "blocked_by" && row.unresolved) parts.push("not done");
  if (row.trashed) parts.push("in trash");
  return parts.join(" · ");
}
