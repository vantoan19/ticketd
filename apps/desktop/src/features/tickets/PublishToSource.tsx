import { useEffect, useState } from "react";
import { Send, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusDot } from "@/components/ui/status-dot";
import type { PublicationAttempt, Ticket } from "@/lib/api/client";
import {
  sourcesClient,
  toSourceFailure,
  type PublicationPreview,
} from "@/lib/api/sources";
import { providerName } from "./ticket-source";
import "./publication.css";

/** GitHub is the only built-in source that can publish. */
const PROVIDER = "github";

/**
 * Whether and how a local ticket can be published, read from the core. Failure
 * to read leaves the rail without a Publish action rather than guessing.
 */
function usePublicationPreview(ticket: Ticket): PublicationPreview | null {
  const [preview, setPreview] = useState<PublicationPreview | null>(null);
  const publication = ticket.publication?.state ?? "";
  useEffect(() => {
    let active = true;
    sourcesClient.previewPublication(ticket.reference, PROVIDER).then(
      (found) => {
        if (active) setPreview(found);
      },
      () => {
        if (active) setPreview(null);
      },
    );
    return () => {
      active = false;
    };
  }, [ticket.reference, ticket.status, ticket.trashed, publication]);
  return preview;
}

/** The Source rail's content for a ticket that has never had an external identity. */
export function LocalPublication({
  ticket,
  refresh,
}: {
  ticket: Ticket;
  refresh: () => Promise<void>;
}) {
  const preview = usePublicationPreview(ticket);
  const [publishing, setPublishing] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const attempt = ticket.publication;
  if (attempt?.state === "in_flight")
    return (
      <small className="rail-note" role="status">
        Publishing to {attempt.destination}…
      </small>
    );
  if (attempt)
    return (
      <>
        <UnresolvedPublication
          attempt={attempt}
          onReview={() => setReviewing(true)}
        />
        <AttemptReview
          attempt={attempt}
          open={reviewing}
          onOpenChange={setReviewing}
        />
      </>
    );
  if (!preview || ticket.trashed) return null;
  if (preview.eligibility.kind === "eligible")
    return (
      <>
        <Button variant="ghost" size="sm" onClick={() => setPublishing(true)}>
          <Send data-icon="inline-start" />
          Publish to {preview.provider_name}…
        </Button>
        {publishing && (
          <PublishDialog
            ticket={ticket}
            onOpenChange={setPublishing}
            refresh={refresh}
          />
        )}
      </>
    );
  const { reason, message } = preview.eligibility;
  if (reason === "status")
    return (
      <small className="rail-note">
        Done, Canceled and Duplicate tickets are not published. {message}
      </small>
    );
  return null;
}

/** The warning at the top of a ticket whose publication outcome is not known. */
export function PublicationNotice({ ticket }: { ticket: Ticket }) {
  const attempt = ticket.publication;
  if (!attempt || attempt.state !== "unresolved") return null;
  return (
    <p className="publication-notice" role="status">
      <StatusDot tone="attention" size={8} />
      Publication unresolved: {providerName(attempt.provider)} may already have
      created the issue in {attempt.destination}. Publishing again is blocked.
    </p>
  );
}

/** The recessed warning for a publication whose outcome is not known. */
function UnresolvedPublication({
  attempt,
  onReview,
}: {
  attempt: PublicationAttempt;
  onReview: () => void;
}) {
  return (
    <div className="publication-unresolved" role="status">
      <span className="rail-value">
        <StatusDot tone="attention" size={8} />
        Publication unresolved
      </span>
      <small className="rail-note">
        ticketd could not confirm whether {providerName(attempt.provider)}{" "}
        created the issue in {attempt.destination}. It may already exist.
        Publishing again is blocked until this is resolved.
      </small>
      <Button variant="ghost" size="sm" onClick={onReview}>
        <TriangleAlert data-icon="inline-start" />
        Review details
      </Button>
    </div>
  );
}

/**
 * What is saved about an unresolved attempt, and what is known and unknown. It
 * offers no way to retry: resolving an unknown outcome is a separate workflow.
 */
function AttemptReview({
  attempt,
  open,
  onOpenChange,
}: {
  attempt: PublicationAttempt;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const name = providerName(attempt.provider);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="publication-dialog">
        <DialogHeader>
          <DialogTitle>Publication unresolved</DialogTitle>
          <DialogDescription>
            {attempt.reference} stays a local ticket. Nothing was attached to
            it.
          </DialogDescription>
        </DialogHeader>
        <div className="publication-facts">
          <section aria-label="Known">
            <h4>What is known</h4>
            <ul>
              <li>
                ticketd asked {name} to create an issue in{" "}
                <strong>{attempt.destination}</strong> titled “{attempt.title}”.
              </li>
              <li>The request was sent on {attempt.started_at}.</li>
              {attempt.issue && (
                <li>
                  {name} created <strong>{attempt.issue.display}</strong>, but
                  ticketd could not attach it to this ticket.
                </li>
              )}
            </ul>
          </section>
          <section aria-label="Unknown">
            <h4>What is not known</h4>
            <ul>
              {attempt.issue ? (
                <li>
                  Whether the issue was changed or closed since it was created.
                </li>
              ) : (
                <li>
                  Whether {name} created the issue. It may exist even though no
                  answer arrived.
                </li>
              )}
            </ul>
            {attempt.failure && (
              <p className="publication-detail">{attempt.failure.message}</p>
            )}
          </section>
        </div>
        <p className="publication-detail">
          Creating the issue again is blocked, so a second issue cannot appear
          by accident. Resolving an unknown outcome is not available yet; check{" "}
          {attempt.destination} on {name} before doing anything by hand.
        </p>
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  );
}

type Phase =
  | { kind: "loading" }
  | { kind: "ready"; preview: PublicationPreview }
  | { kind: "publishing"; preview: PublicationPreview }
  | { kind: "unresolved"; message: string }
  | { kind: "unavailable"; message: string };

/**
 * Previews the issue exactly as it will be sent, then creates it. A failure the
 * provider definitely refused can be tried again; an unknown outcome cannot.
 */
export function PublishDialog({
  ticket,
  onOpenChange,
  refresh,
}: {
  ticket: Ticket;
  onOpenChange: (open: boolean) => void;
  refresh: () => Promise<void>;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [destination, setDestination] = useState<string | undefined>();
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    sourcesClient
      .previewPublication(ticket.reference, PROVIDER, destination)
      .then(
        (preview) => {
          if (!active) return;
          if (preview.eligibility.kind !== "eligible")
            setPhase({
              kind: "unavailable",
              message: preview.eligibility.message,
            });
          else setPhase({ kind: "ready", preview });
        },
        (reason: unknown) => {
          if (active)
            setPhase({
              kind: "unavailable",
              message: toSourceFailure(reason).message,
            });
        },
      );
    return () => {
      active = false;
    };
  }, [ticket.reference, destination]);

  const preview =
    phase.kind === "ready" || phase.kind === "publishing"
      ? phase.preview
      : null;
  const publishing = phase.kind === "publishing";
  const chosen = destination ?? preview?.destination ?? "";

  async function publish() {
    if (!preview || !chosen) return;
    setError("");
    setPhase({ kind: "publishing", preview });
    try {
      await sourcesClient.publish(ticket.reference, PROVIDER, chosen);
      await refresh();
      onOpenChange(false);
    } catch (reason) {
      const failure = toSourceFailure(reason);
      if (failure.code === "publication_unresolved") {
        setPhase({ kind: "unresolved", message: failure.message });
        await refresh().catch(() => {});
        return;
      }
      // A refusal proves nothing was created, so trying again is safe.
      setError(failure.message);
      setPhase({ kind: "ready", preview });
    }
  }

  const name = preview?.provider_name ?? providerName(PROVIDER);
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !publishing) onOpenChange(false);
      }}
    >
      <DialogContent className="publication-dialog">
        <DialogHeader>
          <DialogTitle>
            Publish {ticket.reference} to {name}
          </DialogTitle>
          <DialogDescription>
            This creates one ordinary issue. {ticket.reference} keeps its
            reference, notes, relationships and subtickets; afterwards {name}{" "}
            owns the title and description.
          </DialogDescription>
        </DialogHeader>
        {phase.kind === "loading" && <p role="status">Preparing preview…</p>}
        {phase.kind === "unavailable" && (
          <p className="publication-error" role="alert">
            {phase.message}
          </p>
        )}
        {phase.kind === "unresolved" && (
          <div className="publication-error" role="alert">
            <p>
              <strong>The outcome is not known.</strong> {phase.message}
            </p>
            <p>
              {ticket.reference} stays local and cannot be published again until
              this is resolved. Check {name} before doing anything by hand.
            </p>
          </div>
        )}
        {preview && (
          <div className="publication-preview">
            <div className="publication-field">
              <span className="publication-label" id="publication-destination">
                Destination
              </span>
              {preview.destinations.length > 1 ? (
                <Select
                  value={chosen}
                  onValueChange={setDestination}
                  disabled={publishing}
                >
                  <SelectTrigger aria-labelledby="publication-destination">
                    <SelectValue placeholder="Choose a repository" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {preview.destinations.map((item) => (
                        <SelectItem key={item} value={item}>
                          {item}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              ) : (
                <span aria-labelledby="publication-destination">
                  {chosen || "No destination configured"}
                </span>
              )}
            </div>
            <div className="publication-field">
              <span className="publication-label">Title</span>
              <p className="publication-title">{preview.title}</p>
            </div>
            <div className="publication-field">
              <span className="publication-label">Description</span>
              {preview.body ? (
                <pre
                  className="publication-body"
                  tabIndex={0}
                  aria-label="Description as it will be sent"
                >
                  {preview.body}
                </pre>
              ) : (
                <p className="publication-detail">No description.</p>
              )}
            </div>
            <p className="publication-detail">
              Nothing else is sent: no notes, Efforts, dependencies, subtickets,
              labels or comments, and nothing that mentions ticketd.
            </p>
          </div>
        )}
        {error && (
          <p className="publication-error" role="alert">
            {error} {ticket.reference} remains a local ticket and nothing was
            created.
          </p>
        )}
        {publishing && <p role="status">Publishing to {name}…</p>}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={publishing}
            onClick={() => onOpenChange(false)}
          >
            {phase.kind === "unresolved" ? "Close" : "Cancel"}
          </Button>
          {phase.kind !== "unresolved" && (
            <Button
              disabled={!preview || publishing || !chosen}
              onClick={() => void publish()}
            >
              {publishing ? "Publishing…" : `Publish to ${chosen || name}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
