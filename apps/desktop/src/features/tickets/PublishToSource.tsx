import { useEffect, useState } from "react";
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
import type { Ticket } from "@/lib/api/client";
import {
  sourcesClient,
  toSourceFailure,
  type PublicationPreview,
} from "@/lib/api/sources";
import {
  usePublishTarget,
  usePublicationPreview,
  publicationReason,
} from "./use-publication-preview";
import { AttemptReview, ReviewBody } from "./ResolvePublication";
import { MarkdownDocument } from "@/features/markdown/MarkdownDocument";
import { useSourceActivity } from "./source-activity";
import { formatDateTime } from "@/lib/format";
import { providerName } from "./ticket-source";
import "./publication.css";

/** The Source rail's content for a ticket that has never had an external identity. */
export function LocalPublication({
  ticket,
  refresh,
}: {
  ticket: Ticket;
  refresh: () => Promise<void>;
}) {
  const target = usePublishTarget();
  const activity = useSourceActivity();
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
        <UnresolvedPublication onReview={() => setReviewing(true)} />
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
        <Button
          variant="link"
          size="sm"
          className="rail-publish-link"
          onClick={() => setPublishing(true)}
        >
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
  return (
    <small className="rail-note">
      {publicationReason(preview)}
      {preview.eligibility.reason === "source_not_connected" && (
        <>
          {" "}
          <Button variant="link" size="sm" onClick={activity.openSettings}>
            Settings
          </Button>
        </>
      )}
    </small>
  );
}

/** The warning at the top of a ticket whose publication outcome is not known. */
export function PublicationNotice({
  ticket,
  refresh,
}: {
  ticket: Ticket;
  refresh: () => Promise<void>;
}) {
  const [publishing, setPublishing] = useState<string | null>(null);
  const attempt = ticket.publication;
  if (publishing)
    return (
      <PublishDialog
        ticket={ticket}
        provider={publishing}
        onOpenChange={(open) => {
          if (!open) setPublishing(null);
        }}
        refresh={refresh}
      />
    );
  if (!attempt || attempt.state !== "unresolved") return null;
  return (
    <section
      className="publication-notice"
      aria-label="Publish outcome unknown"
    >
      <h3>
        <StatusDot tone="attention" size={10} />
        Publish outcome unknown
      </h3>
      <p>
        {providerName(attempt.provider)} may have created an issue in{" "}
        <span className="source-number">{attempt.destination}</span> when you
        published <span className="source-number">{attempt.reference}</span> at{" "}
        {formatDateTime(attempt.started_at)}. This ticket stays Local until the
        outcome is settled.
      </p>
      <ReviewBody
        inline
        attempt={attempt}
        close={(kind) => {
          if (kind === "not_created") setPublishing(attempt.provider);
        }}
        refresh={refresh}
      />
    </section>
  );
}

/** The recessed warning for a publication whose outcome is not known. */
function UnresolvedPublication({ onReview }: { onReview: () => void }) {
  return (
    <div className="publication-unresolved">
      <span className="rail-value">
        <StatusDot tone="attention" size={10} />
        Publish outcome unknown
      </span>
      <small className="rail-note">
        Stays Local until the outcome is settled.
      </small>
      <Button variant="ghost" size="sm" onClick={onReview}>
        Review details
      </Button>
    </div>
  );
}

type Phase =
  | { kind: "loading"; preview?: PublicationPreview }
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

  const preview = "preview" in phase ? (phase.preview ?? null) : null;
  const publishing = phase.kind === "publishing";
  const chosen = destination ?? preview?.destination ?? "";

  async function publish() {
    if (phase.kind !== "ready" || !preview || !chosen) return;
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
      setError(
        failure.code === "publication_failed" &&
          !/nothing was created/i.test(failure.message)
          ? `${failure.message.replace(/[.!?]$/, "")}. Nothing was created.`
          : failure.message,
      );
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
      <DialogContent
        className="publication-dialog publish-dialog"
        showCloseButton={false}
      >
        <DialogHeader showCloseButton>
          <DialogTitle>
            Publish{" "}
            <span className="publication-reference">{ticket.reference}</span> to{" "}
            {name}
          </DialogTitle>
          <DialogDescription>
            Creates an ordinary open issue. Afterwards {name} owns the title and
            description, and they become read-only here.
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
                Repository
              </span>
              {preview.destinations.length > 0 ? (
                <Select
                  value={chosen}
                  onValueChange={(value) => {
                    setDestination(value);
                    setPhase({ kind: "loading", preview });
                    setError("");
                  }}
                  disabled={publishing || preview.destinations.length === 1}
                >
                  <SelectTrigger
                    className="publication-repository"
                    readOnly={preview.destinations.length === 1}
                    aria-labelledby="publication-destination"
                  >
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
            <section className="publication-field" aria-label="Issue preview">
              <h3>Issue preview</h3>
              <div className="publication-issue-card">
                <h4>{preview.title}</h4>
                <div
                  className="markdown-preview"
                  aria-label="Description as it will be sent"
                >
                  <MarkdownDocument
                    source={preview.body || "No description."}
                  />
                </div>
              </div>
              <p className="publication-detail">
                Sent exactly as shown. No ticketd labels, fields or comments are
                added.
              </p>
            </section>
            <section className="publication-field">
              <h3>Stays in ticketd</h3>
              <ul className="publication-local-list">
                <li>
                  Reference{" "}
                  <span className="source-number">{ticket.reference}</span> and
                  status {ticket.status}
                </li>
                <li>
                  {preview.local
                    ? `${preview.local.activities} ${preview.local.activities === 1 ? "activity" : "activities"}, `
                    : "Notes, "}
                  Plan, tags and relationships — never sent to GitHub
                </li>
                {(preview.local?.subtickets.length
                  ? preview.local.subtickets
                  : ticket.children.map((child) => child.reference)
                ).length > 0 ? (
                  (
                    preview.local?.subtickets ??
                    ticket.children.map((child) => child.reference)
                  ).map((reference) => (
                    <li key={reference}>
                      Subticket{" "}
                      <span className="source-number">{reference}</span> stays
                      local unless you publish it separately
                    </li>
                  ))
                ) : (
                  <li>
                    Subtickets stay local unless you publish them separately.
                  </li>
                )}
              </ul>
            </section>
          </div>
        )}
        {error && (
          <p className="publication-error" role="alert">
            {/[.!?]$/.test(error) ? error : `${error}.`}
          </p>
        )}
        {publishing && <p role="status">Publishing to {name}…</p>}
        <DialogFooter className="publication-footer">
          <p className="publication-detail">
            Nothing is sent until you publish.
          </p>
          <Button
            variant="ghost"
            size="sm"
            disabled={publishing}
            onClick={() => onOpenChange(false)}
          >
            {phase.kind === "unresolved" ? "Close" : "Cancel"}
          </Button>
          {phase.kind !== "unresolved" && (
            <Button
              size="sm"
              disabled={
                phase.kind !== "ready" || !preview || publishing || !chosen
              }
              onClick={() => void publish()}
            >
              {publishing ? "Publishing…" : "Publish issue"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
