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
import { useSources } from "@/features/settings/sources/use-sources";
import { AttemptReview } from "./ResolvePublication";
import { providerName } from "./ticket-source";
import "./publication.css";

/**
 * The source a local ticket can be published to: the first connector that
 * declares the publish capability, and when it was last saved, so connecting it in
 * Settings makes the answer change.
 */
function usePublishTarget(): { provider: string; saved: string } | null {
  const { entries } = useSources();
  const entry = entries.find((item) =>
    item.connector.capabilities.includes("publish"),
  );
  return entry
    ? {
        provider: entry.connector.provider,
        saved: entry.saved?.saved_at ?? "",
      }
    : null;
}

/**
 * Whether and how a local ticket can be published, read from the core. It reads
 * again whenever what decides the answer changes (the ticket's title, description,
 * status, trash or attempt, or the source being saved). Failure to read leaves the
 * rail without a Publish action rather than guessing.
 */
function usePublicationPreview(
  ticket: Ticket,
  target: { provider: string; saved: string } | null,
): PublicationPreview | null {
  const [preview, setPreview] = useState<PublicationPreview | null>(null);
  const publication = ticket.publication?.state ?? "";
  const provider = target?.provider;
  const saved = target?.saved;
  useEffect(() => {
    if (!provider) return;
    let active = true;
    sourcesClient.previewPublication(ticket.reference, provider).then(
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
  }, [
    provider,
    saved,
    ticket.reference,
    ticket.title,
    ticket.body,
    ticket.status,
    ticket.trashed,
    publication,
  ]);
  return provider ? preview : null;
}

/** The Source rail's content for a ticket that has never had an external identity. */
export function LocalPublication({
  ticket,
  refresh,
}: {
  ticket: Ticket;
  refresh: () => Promise<void>;
}) {
  const target = usePublishTarget();
  const preview = usePublicationPreview(ticket, target);
  const [publishing, setPublishing] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const attempt = ticket.publication;
  if (attempt?.state === "in_flight")
    return (
      <small className="rail-note">Publishing to {attempt.destination}…</small>
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
          refresh={refresh}
        />
      </>
    );
  if (!preview) return null;
  if (preview.eligibility.kind === "eligible")
    return (
      <>
        <Button variant="ghost" size="sm" onClick={() => setPublishing(true)}>
          <Send data-icon="inline-start" />
          Publish to {preview.provider_name}…
        </Button>
        {publishing && target && (
          <PublishDialog
            ticket={ticket}
            provider={target.provider}
            onOpenChange={setPublishing}
            refresh={refresh}
          />
        )}
      </>
    );
  // The core states why, and what to do about it; the rail only shows it.
  return <small className="rail-note">{preview.eligibility.message}</small>;
}

/** The warning at the top of a ticket whose publication outcome is not known. */
export function PublicationNotice({ ticket }: { ticket: Ticket }) {
  const attempt = ticket.publication;
  if (!attempt || attempt.state !== "unresolved") return null;
  return (
    <p className="publication-notice">
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
    <div className="publication-unresolved">
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
  provider,
  onOpenChange,
  refresh,
}: {
  ticket: Ticket;
  provider: string;
  onOpenChange: (open: boolean) => void;
  refresh: () => Promise<void>;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [destination, setDestination] = useState<string | undefined>();
  const [error, setError] = useState("");
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let active = true;
    sourcesClient
      .previewPublication(ticket.reference, provider, destination)
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
  }, [ticket.reference, provider, destination, reloads]);

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
      await sourcesClient.publish(
        ticket.reference,
        provider,
        chosen,
        preview.fingerprint,
      );
      await refresh();
      onOpenChange(false);
    } catch (reason) {
      const failure = toSourceFailure(reason);
      if (failure.code === "publication_unresolved") {
        setPhase({ kind: "unresolved", message: failure.message });
        await refresh().catch(() => {});
        return;
      }
      // A refusal proves nothing was created, so trying again is safe. A ticket
      // that changed since the preview sent nothing: show what it holds now.
      setError(failure.message);
      if (failure.code === "publication_changed") {
        setPhase({ kind: "loading" });
        setReloads((count) => count + 1);
      } else setPhase({ kind: "ready", preview });
    }
  }

  const name = preview?.provider_name ?? providerName(provider);
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
