import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { StatusIcon } from "@/features/tickets/StatusIcon";
import {
  applyLabel,
  choiceLabels,
  consequence,
  replacementIssueReason,
  summarize,
  type Choice,
} from "@/features/tickets/duplicate-review";
import {
  client,
  type Ticket,
  type DuplicatePreview,
  type DependencyDecision,
  type WaitingOutcome,
} from "@/lib/api/client";
import { toFailure } from "@/lib/api/bridge-failure";
import { useOnWorkspaceChange } from "@/lib/workspace-change";
import { useTicketSearch } from "./useTicketSearch";
import "./linked-work.css";
import "./duplicate-review.css";

type Unchosen = Choice | "";
/** Why the preview can no longer be applied: its review changed, or it is for the other kind of review. */
/**
 * The canonical ticket typed so far for each ticket. Escape closes the dialog
 * without losing it; Cancel and a finished review discard it.
 */
const canonicalDrafts = new Map<string, string>();

type Stale = "" | "changed" | "mode";

function staleKind(code: string): Stale {
  if (code === "review_changed") return "changed";
  if (code === "review_mode") return "mode";
  return "";
}

function TicketSummary({
  label,
  ticket,
  icon = ticket.status,
  note,
}: {
  label: string;
  ticket: Pick<Ticket, "reference" | "title" | "status">;
  /** The status whose icon to show; defaults to the ticket's own. */
  icon?: string;
  note: string;
}) {
  return (
    <div className="duplicate-ticket" role="group" aria-label={label}>
      <span className="duplicate-ticket-label">{label}</span>
      <span className="duplicate-ticket-title">
        <span className="duplicate-ticket-reference">{ticket.reference}</span>{" "}
        {ticket.title}
      </span>
      <span className="duplicate-ticket-status">
        <StatusIcon status={icon} size={14} decorative />
        {note}
      </span>
    </div>
  );
}

/** The review that marks a ticket as a duplicate and decides each affected dependency. */
export function Duplicates({
  ticket,
  refresh,
  onDone,
  onCancel,
  startSeparate = false,
  initialCanonical = "",
}: {
  ticket: Ticket;
  /** The canonical ticket to review first, when the caller already knows it. */
  initialCanonical?: string;
  /** Opens on the separate dependency review rather than on marking a duplicate. */
  startSeparate?: boolean;
  refresh: () => Promise<void>;
  /** Called after the duplicate and its dependency changes are saved. */
  onDone?: () => void;
  onCancel?: () => void;
}) {
  const canonicalInput = useRef<HTMLInputElement>(null);
  const [canonical, setCanonicalText] = useState(
    initialCanonical || canonicalDrafts.get(ticket.reference) || "",
  );
  function setCanonical(value: string) {
    setCanonicalText(value);
    canonicalDrafts.set(ticket.reference, value);
  }
  const [preview, setPreview] = useState<DuplicatePreview | null>(null);
  const [canonicalTicket, setCanonicalTicket] = useState<Ticket | null>(null);
  const [choices, setChoices] = useState<Unchosen[]>([]);
  const [error, setError] = useState("");
  // The core's answer for one set of choices, kept with the key of the choices it answers.
  const [answer, setAnswer] = useState<{
    key: string;
    outcomes: WaitingOutcome[];
    failure: string;
  } | null>(null);
  const [stale, setStale] = useState<Stale>("");
  const [pending, setPending] = useState(false);
  const [attempt, setAttempt] = useState<{ key: string; id: string } | null>(
    null,
  );
  const [separate, setSeparate] = useState(startSeparate);

  // Arriving at the form (for example after picking the ticket to mark) puts the
  // cursor where the next answer goes, not on the dialog's frame.
  useEffect(() => {
    canonicalInput.current?.focus();
  }, []);
  const target = canonical.trim();
  const search = useTicketSearch(
    canonical,
    !preview,
    (item) =>
      item.reference !== ticket.reference &&
      !item.trashed &&
      (separate || item.status !== "Duplicate"),
  );
  const matches = canonical.trim() ? search.results : [];
  // Separate review replaces an existing endpoint with this ticket, after its duplicate link was removed.
  // The preview's normalized form of the source, which its edges refer to; the typed
  // text (T-01) only until a preview is loaded.
  const sourceRef = preview?.source ?? (separate ? target : ticket.reference);
  const canonicalArg = separate ? ticket.reference : target;

  // The core judges all choices together; the review only shows what it answers. Choices
  // not made yet count as Keep, which is the current graph.
  const answerKey = preview
    ? `${preview.edges[0]?.basis ?? ""}|${separate}|${choices.join(",")}`
    : "";
  const evaluating =
    !!preview && preview.edges.length > 0 && answer?.key !== answerKey;
  const outcomes = answer?.key === answerKey ? answer.outcomes : [];
  useEffect(() => {
    if (!preview || preview.edges.length === 0) return;
    let current = true;
    const decisions: DependencyDecision[] = preview.edges.map(
      (edge, index) => ({
        edge,
        choice: (choices[index] || "retain") as Choice,
      }),
    );
    client
      .evaluateDuplicate(preview.source, canonicalArg, separate, decisions)
      .then((result) => {
        if (current)
          setAnswer({ key: answerKey, outcomes: result, failure: "" });
      })
      .catch((reason: unknown) => {
        if (!current) return;
        const failure = toFailure(reason);
        const kind = staleKind(failure.code);
        if (kind) setStale(kind);
        // Never leave the previous choice's lines beside the error.
        // A stale review has its own notice with a Refresh action.
        setAnswer({
          key: answerKey,
          outcomes: [],
          failure: kind ? "" : failure.message,
        });
      });
    return () => {
      current = false;
    };
  }, [preview, choices, canonicalArg, separate, answerKey]);

  // Dependencies can change under an open review (from the CLI, another
  // window). Compare the shown preview with a fresh one and ask for a refresh
  // rather than leaving rows that no longer match.
  useOnWorkspaceChange(() => {
    if (!preview || stale || pending) return;
    const shown = JSON.stringify([preview.canonical, preview.edges]);
    void client
      .previewDuplicate(
        separate ? target : ticket.reference,
        canonicalArg,
        separate,
      )
      .then((latest) => {
        if (JSON.stringify([latest.canonical, latest.edges]) !== shown)
          setStale("changed");
      })
      .catch(() => {});
  });

  async function loadPreview(chosen?: string) {
    const picked = chosen ?? target;
    const pickedArg = separate ? ticket.reference : picked;
    setPending(true);
    setError("");
    setStale("");
    try {
      const result = await client.previewDuplicate(
        separate ? picked : ticket.reference,
        pickedArg,
        separate,
      );
      const resolved = separate
        ? null
        : await client.showTicket(result.canonical);
      setPreview(result);
      setCanonicalTicket(resolved);
      setChoices(result.edges.map(() => ""));
    } catch (reason) {
      setPreview(null);
      setError(String(reason));
    } finally {
      setPending(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void loadPreview();
  }

  function changeCanonical(nextSeparate = separate) {
    setSeparate(nextSeparate);
    setPreview(null);
    setCanonicalTicket(null);
    setChoices([]);
    setError("");
    setStale("");
    setTimeout(() => canonicalInput.current?.focus());
  }

  async function apply() {
    if (!preview) return;
    const key = JSON.stringify({ target, preview, choices, separate });
    const id = attempt?.key === key ? attempt.id : crypto.randomUUID();
    setAttempt({ key, id });
    setPending(true);
    setError("");
    try {
      const decisions: DependencyDecision[] = preview.edges.map(
        (edge, index) => ({ edge, choice: choices[index] as Choice }),
      );
      if (separate)
        await client.editDependenciesReviewed(
          target,
          ticket.reference,
          preview.canonical,
          decisions,
          id,
        );
      else
        await client.markDuplicateReviewed(
          ticket.reference,
          target,
          preview.canonical,
          decisions,
          id,
        );
      setAttempt(null);
      await refresh();
      canonicalDrafts.delete(ticket.reference);
      onDone?.();
    } catch (reason) {
      const failure = toFailure(reason);
      const kind = staleKind(failure.code);
      if (kind) setStale(kind);
      else setError(failure.message);
    } finally {
      setPending(false);
    }
  }

  const shownError = error || (answer?.key === answerKey ? answer.failure : "");
  const complete = !!preview && choices.every((choice) => choice);
  return (
    <div className="duplicate-review" aria-label="Duplicate review">
      {ticket.duplicate_of && (
        <p className="duplicate-note">
          {ticket.reference} is already a duplicate of {ticket.duplicate_of}.
          Marking it again changes the canonical ticket.
        </p>
      )}
      {preview && (canonicalTicket || separate) ? (
        <>
          <div className="duplicate-scroll">
            {separate && (
              <p className="duplicate-note">
                Replace {target} with {ticket.reference} in each dependency
                below.
              </p>
            )}
            {canonicalTicket && (
              <div className="duplicate-tickets">
                <TicketSummary
                  label="Duplicate"
                  ticket={ticket}
                  icon="Duplicate"
                  note={`${ticket.status} → Duplicate · Duplicate of ${preview.canonical}`}
                />
                <TicketSummary
                  label="Canonical ticket"
                  ticket={canonicalTicket}
                  note={`${canonicalTicket.status} · unchanged`}
                />
              </div>
            )}
            <div>
              <Button
                type="button"
                variant="link"
                className="duplicate-change"
                disabled={pending}
                onClick={() => changeCanonical()}
              >
                {separate
                  ? "Change existing endpoint"
                  : "Change canonical ticket"}
              </Button>
              {!separate && preview.canonical !== target && (
                <p className="duplicate-note">
                  {target} is itself a duplicate, so {ticket.reference} points
                  to {preview.canonical}.
                </p>
              )}
            </div>
            {preview.edges.length > 0 ? (
              <section
                aria-label="Affected dependencies"
                className="dependencies"
              >
                <h3>Affected dependencies</h3>
                <p className="duplicate-note">
                  {separate
                    ? `Each of these dependencies is being moved from ${target} to ${ticket.reference}, so each needs a decision.`
                    : "A duplicate ticket never satisfies a blocking dependency, so each of these needs a decision."}
                </p>
                <ul>
                  {preview.edges.map((edge, index) => {
                    const issue = preview.replacement_issues[index] ?? null;
                    const reason = issue
                      ? `Replace unavailable: ${replacementIssueReason(edge, issue)}`
                      : "";
                    const name = `${edge.blocker} blocks ${edge.dependent}`;
                    const choice = choices[index] ?? "";
                    return (
                      <li key={name} className="dependency-edge">
                        <div className="dependency-edges">
                          <span>
                            <span className="dependency-edge-label">
                              Current
                            </span>{" "}
                            {name}
                          </span>
                          <span>
                            <span className="dependency-edge-label">
                              Proposed
                            </span>{" "}
                            {edge.replacement_blocker} blocks{" "}
                            {edge.replacement_dependent}
                          </span>
                        </div>
                        <SegmentedControl<Unchosen>
                          aria-label={`Choice for ${name}`}
                          value={choice}
                          onValueChange={(next) =>
                            setChoices((current) =>
                              current.map((value, i) =>
                                i === index ? next : value,
                              ),
                            )
                          }
                          options={(
                            ["replace", "remove", "retain"] as const
                          ).map((value) => ({
                            value,
                            label: choiceLabels[value],
                            disabled:
                              !!stale || (value === "replace" && !!issue),
                            ...(value === "replace" && reason
                              ? { title: reason }
                              : {}),
                          }))}
                        />
                        {reason && (
                          <p className="dependency-reason">{reason}.</p>
                        )}
                        <p className="dependency-consequence">
                          {choice
                            ? consequence(
                                sourceRef,
                                edge,
                                choice,
                                outcomes,
                                separate,
                              )
                            : "Choose what happens to this dependency."}
                        </p>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ) : (
              <p className="duplicate-note">
                {sourceRef} has no dependencies to review.
              </p>
            )}
            <p className="duplicate-summary">
              {separate
                ? "All of the chosen changes are applied together or not at all."
                : summarize(ticket.reference, preview.canonical, choices)}
            </p>
            {!separate && (
              <p className="duplicate-note">
                Removing the duplicate link later restores the earlier status.
                Any dependency changes you apply now stay as they are.
              </p>
            )}
          </div>
          {stale && (
            <div role="alert" className="duplicate-stale">
              <p>
                {stale === "mode"
                  ? "This preview was made for a different kind of review, so nothing was applied. Refresh the preview to review it again."
                  : "Dependencies changed after this preview, so nothing was applied. Refresh the preview to review the current dependencies."}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() => void loadPreview()}
              >
                Refresh preview
              </Button>
            </div>
          )}
          {shownError && (
            <p role="alert" className="duplicate-error">
              {shownError}
            </p>
          )}
          <DialogFooter className="items-center">
            <p className="mr-auto text-xs text-muted-foreground">
              {complete
                ? "Nothing changes until you apply."
                : "Choose Replace, Keep or Remove for each dependency."}
            </p>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                canonicalDrafts.delete(ticket.reference);
                onCancel?.();
              }}
            >
              Cancel
            </Button>
            <Button
              disabled={pending || !!stale || evaluating || !complete}
              onClick={() => void apply()}
            >
              {separate ? "Apply dependency changes" : applyLabel(choices)}
            </Button>
          </DialogFooter>
        </>
      ) : (
        <form onSubmit={submit} className="duplicate-form">
          <FieldGroup>
            <Field data-invalid={!!error}>
              <FieldLabel htmlFor={`canonical-${ticket.id}`}>
                {separate
                  ? "Existing endpoint to replace"
                  : "Canonical ticket reference"}
              </FieldLabel>
              <div className="duplicate-input">
                <Input
                  ref={canonicalInput}
                  id={`canonical-${ticket.id}`}
                  value={canonical}
                  onChange={(event) => setCanonical(event.target.value)}
                  placeholder="Search by title or T-number"
                  autoComplete="off"
                  required
                  aria-invalid={!!error}
                />
                <Button type="submit" variant="outline" disabled={pending}>
                  Review dependencies
                </Button>
              </div>
              <FieldError>{error}</FieldError>
              {matches.length > 0 && (
                <ul className="link-ticket-results" aria-label="Matches">
                  {matches.map((item) => (
                    <li key={item.reference}>
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => {
                          setCanonical(item.reference);
                          void loadPreview(item.reference);
                        }}
                      >
                        <StatusIcon status={item.status} size={14} decorative />
                        <span className="link-ticket-reference">
                          {item.reference}
                        </span>
                        <span>{item.title}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Field>
          </FieldGroup>
          <Button
            type="button"
            variant="link"
            className="duplicate-change"
            disabled={pending}
            onClick={() => changeCanonical(!separate)}
          >
            {separate
              ? "Mark a duplicate"
              : "Review separate dependency changes"}
          </Button>
        </form>
      )}
    </div>
  );
}
