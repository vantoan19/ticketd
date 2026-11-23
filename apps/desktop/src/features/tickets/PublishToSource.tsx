import { useEffect, useRef, useState } from "react";
import { FailureDetails, FailureAlert } from "@/components/ui/failure-alert";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { Button } from "@/components/ui/button";
import { Upload } from "lucide-react";
import { RailRow } from "./RailSection";
import { DialogShell } from "@/components/ui/dialog-shell";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { StatusDot } from "@/components/ui/status-dot";
import { client, type Ticket } from "@/lib/api/client";
import {
  providerName,
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
import { useSources } from "@/features/settings/sources/use-sources";
import { AttachmentLink } from "@/features/attachments/AttachmentLink";
import { ExportMarkdownButton } from "@/features/attachments/ExportMarkdown";
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
  // Nothing to publish to: the Source section says only "Local".
  if (!target || !preview) return null;
  if (
    preview.eligibility.kind === "eligible" ||
    preview.eligibility.reason === "internal_attachments"
  )
    return (
      <>
        <RailRow
          icon={<Upload aria-hidden="true" />}
          muted
          onClick={() => setPublishing(true)}
        >
          Publish to {preview.provider_name}…
        </RailRow>
        {publishing && (
          <PublishDialog
            ticket={ticket}
            provider={target.provider}
            onOpenChange={setPublishing}
            refresh={refresh}
          />
        )}
      </>
    );
  // The core states why; the rail shows one short reason, and the way out
  // when it is a connection.
  if (preview.eligibility.reason === "source_not_connected")
    return (
      <small className="rail-note">
        <Button
          variant="link"
          size="inline"
          onClick={() => activity.openSettings(preview.provider)}
        >
          Connect {preview.provider_name}
        </Button>{" "}
        to publish it.
      </small>
    );
  return <small className="rail-note">{publicationReason(preview)}</small>;
}

/** The warning at the top of a ticket whose publication outcome is not known. */
export function PublicationNotice({
  ticket,
  refresh,
}: {
  ticket: Ticket;
  refresh: () => Promise<void>;
}) {
  const { entries } = useSources();
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
    <Alert
      tone="attention"
      role="region"
      aria-label="Publish outcome unknown"
      className="mb-6"
    >
      <AlertTitle level={3}>Publish outcome unknown</AlertTitle>
      <AlertDescription>
        {providerName(attempt.provider, entries)} may have created an issue in{" "}
        <span className="source-number">{attempt.destination}</span> when you
        published <span className="source-number">{attempt.reference}</span> at{" "}
        {formatDateTime(attempt.started_at)}. This ticket stays Local until the
        outcome is settled.
      </AlertDescription>
      <ReviewBody
        inline
        attempt={attempt}
        close={(kind) => {
          if (kind === "not_created") setPublishing(attempt.provider);
        }}
        refresh={refresh}
      />
    </Alert>
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
  | { kind: "blocked"; preview: PublicationPreview; message: string }
  | { kind: "confirmed" }
  | { kind: "unresolved"; message: string; details: string }
  | { kind: "unavailable"; message: string; details?: string };

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
  const { entries } = useSources();
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [destination, setDestination] = useState<string | undefined>();
  const [error, setError] = useState<FailureDescription | null>(null);
  const [checking, setChecking] = useState(false);
  const [reloads, setReloads] = useState(0);
  const descriptionTarget = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let active = true;
    sourcesClient
      .previewPublication(ticket.reference, provider, destination)
      .then(
        (preview) => {
          if (!active) return;
          if (
            preview.eligibility.kind !== "eligible" &&
            preview.eligibility.reason === "internal_attachments"
          )
            setPhase({
              kind: "blocked",
              preview,
              message: preview.eligibility.message,
            });
          else if (preview.eligibility.kind !== "eligible")
            setPhase({
              kind: "unavailable",
              message: preview.eligibility.message,
            });
          else setPhase({ kind: "ready", preview });
        },
        (reason: unknown) => {
          if (active) {
            const failure = describeFailure(
              reason,
              "prepare the publication preview",
            );
            setPhase({
              kind: "unavailable",
              message: failure.sentence,
              details: failure.details,
            });
          }
        },
      );
    return () => {
      active = false;
    };
  }, [ticket.reference, provider, destination, reloads]);

  const preview = "preview" in phase ? (phase.preview ?? null) : null;
  const publishing = phase.kind === "publishing";
  const chosen = destination ?? preview?.destination ?? "";

  async function checkSavedState() {
    setChecking(true);
    setError(null);
    try {
      // The workspace refresh may retain a cached list on read failure. Read the
      // ticket itself before treating recovery as complete.
      await client.showTicket(ticket.reference);
      await refresh();
      onOpenChange(false);
    } catch (reason) {
      setError(describeFailure(reason, "check the saved publication state"));
    } finally {
      setChecking(false);
    }
  }

  async function publish() {
    if (phase.kind !== "ready" || !preview || !chosen) return;
    setError(null);
    setPhase({ kind: "publishing", preview });
    try {
      await sourcesClient.publish(
        ticket.reference,
        provider,
        chosen,
        preview.fingerprint,
      );
    } catch (reason) {
      const failure = toSourceFailure(reason);
      // Only these Core refusals prove that no issue was created. A lost or
      // unclassified reply is not permission to send another publication.
      if (
        ![
          "publication_failed",
          "publication_changed",
          "publication_ineligible",
        ].includes(failure.code)
      ) {
        const described = describeFailure(
          { code: "publication_unresolved", message: failure.message },
          "publish this ticket",
        );
        setPhase({
          kind: "unresolved",
          message: described.sentence,
          details: described.details,
        });
        void refresh().catch(() => {});
        return;
      }
      setError(describeFailure(failure, "publish this ticket"));
      if (
        failure.code === "publication_changed" ||
        failure.code === "publication_ineligible"
      ) {
        setPhase({ kind: "loading" });
        setReloads((count) => count + 1);
      } else setPhase({ kind: "ready", preview });
      return;
    }
    // Publication already succeeded. A subsequent read can only be retried as
    // a read; it must never restore the write button.
    setPhase({ kind: "confirmed" });
    await checkSavedState();
  }

  const connector = entries.find(
    (entry) => entry.connector.provider === provider,
  )?.connector;
  const name = preview?.provider_name ?? connector?.name ?? provider;
  const target = connector?.presentation?.target;
  const destinationPrompt = target?.choose ?? "Choose a destination";
  const blocked = phase.kind === "blocked";
  const recovering = phase.kind === "unresolved" || phase.kind === "confirmed";
  return (
    <DialogShell
      open
      onOpenChange={(next) => {
        if (!next) onOpenChange(false);
      }}
      size="lg"
      busy={publishing}
      title={
        blocked
          ? "Resolve attachment links before publishing"
          : `Publish ${ticket.reference} to ${name}`
      }
      description={`Creates an ordinary open issue. Afterwards ${name} owns the title and description, and they become read-only here.`}
      cancelLabel={recovering ? "Close" : "Cancel"}
      primaryLabel={
        blocked
          ? "Review description"
          : phase.kind === "confirmed"
            ? "Published"
            : publishing
              ? "Publishing…"
              : "Publish issue"
      }
      blockedReason={
        blocked
          ? null
          : publishing
            ? `Publishing to ${name}…`
            : phase.kind === "confirmed"
              ? "Publication is confirmed; check the saved state to refresh this ticket."
              : phase.kind === "unresolved"
                ? "It can’t be published again until the outcome is known."
                : phase.kind === "unavailable"
                  ? "Publishing is unavailable."
                  : phase.kind === "loading" || !preview
                    ? "Preparing preview…"
                    : chosen
                      ? null
                      : `${destinationPrompt}.`
      }
      footerNote={
        recovering
          ? "Checking saved state sends no issue."
          : "Nothing is sent until you publish."
      }
      // Review description returns to the ticket's description, not the menu.
      returnFocus={descriptionTarget}
      {...(blocked && {
        footerLeading: (
          <ExportMarkdownButton
            source={{ kind: "ticket", reference: ticket.reference }}
            label="Export with files"
          />
        ),
      })}
      {...(error && {
        error: <FailureAlert size="compact" failure={error} />,
      })}
      onSubmit={() => {
        if (blocked) {
          descriptionTarget.current =
            document
              .getElementById(`body-${ticket.id}`)
              ?.closest<HTMLElement>('[role="group"]') ?? null;
          onOpenChange(false);
        } else if (phase.kind === "ready" && chosen) void publish();
      }}
    >
      {phase.kind === "loading" && <p role="status">Preparing preview…</p>}
      {phase.kind === "blocked" && (
        <div className="publication-preview">
          <p className="publication-error" role="alert">
            {phase.message}
          </p>
          <ul
            className="publication-attachment-links"
            aria-label="Workspace-only attachment links"
          >
            {phase.preview.internal_attachments.map((link) => (
              <li key={link.uri}>
                <AttachmentLink uri={link.uri}>
                  {link.display_name ?? link.uri}
                </AttachmentLink>
                <small className="publication-detail">
                  Internal link in ticket description · Select to inspect
                </small>
              </li>
            ))}
          </ul>
          <p className="publication-detail">
            Direct local attachment associations stay with this ticket in
            ticketd. They are not automatically sent to {name}.
          </p>
        </div>
      )}
      {phase.kind === "unavailable" && (
        <p className="publication-error" role="alert">
          {phase.message}
          {phase.details && (
            <FailureDetails variant="popover" details={phase.details} />
          )}
          {phase.details && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setReloads((count) => count + 1)}
            >
              Retry preview
            </Button>
          )}
        </p>
      )}
      {recovering && (
        <div className="publication-error" role="alert">
          {phase.kind === "confirmed" ? (
            <p>
              <strong>Publication confirmed.</strong> The saved ticket could not
              be refreshed.
            </p>
          ) : (
            <>
              <p>
                <strong>The outcome is not known.</strong> {phase.message}
              </p>
              <FailureDetails variant="popover" details={phase.details} />
              <p>
                Check {name} and the saved ticket before doing anything by hand.
                This ticket cannot be published again until the outcome is
                known.
              </p>
            </>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={checking}
            onClick={() => void checkSavedState()}
          >
            {checking ? "Checking saved state…" : "Check saved state"}
          </Button>
        </div>
      )}
      {preview && phase.kind !== "blocked" && (
        <div className="publication-preview">
          <div className="publication-field">
            <span className="publication-label" id="publication-destination">
              {target?.label ?? "Destination"}
            </span>
            {preview.destinations.length > 0 ? (
              <Select
                value={chosen}
                onValueChange={(value) => {
                  setDestination(value);
                  setPhase({ kind: "loading", preview });
                  setError(null);
                }}
                disabled={publishing || preview.destinations.length === 1}
              >
                <SelectTrigger
                  className="publication-repository"
                  readOnly={preview.destinations.length === 1}
                  aria-labelledby="publication-destination"
                >
                  <SelectValue placeholder={destinationPrompt} />
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
                <MarkdownDocument source={preview.body || "No description."} />
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
                {preview.local?.attachments ?? 0} directly attached files stay
                with this ticket and are not automatically published.
              </li>
              <li>
                Reference{" "}
                <span className="source-number">{ticket.reference}</span> and
                status {ticket.status}
              </li>
              <li>
                {preview.local
                  ? `${preview.local.activities} ${preview.local.activities === 1 ? "activity" : "activities"}, `
                  : "Notes, "}
                Plan, tags and relationships — never sent to {name}
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
                    Subticket <span className="source-number">{reference}</span>{" "}
                    stays local unless you publish it separately
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
    </DialogShell>
  );
}
