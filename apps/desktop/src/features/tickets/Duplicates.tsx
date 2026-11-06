import { useEffect, useRef, useState, type RefObject } from "react";
import { Button } from "@/components/ui/button";
import { DialogShell } from "@/components/ui/dialog-shell";
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

/**
 * The dialog that marks a ticket as a duplicate and decides each affected
 * dependency, in one flow: choose the canonical ticket, then Replace, Keep or
 * Remove each dependency. The footer's primary says what it applies. Callers
 * mount it only while open, so closing discards its working state.
 */
export function Duplicates({
  ticket,
  refresh,
  open,
  onOpenChange,
  title,
  description,
  returnFocus,
  onDone,
  onCancel,
  onApplyFailure,
  startSeparate = false,
  initialCanonical = "",
}: {
  ticket: Ticket;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  /** Where focus goes on close when the opener no longer exists. */
  returnFocus?: RefObject<HTMLElement | null>;
  /** The canonical ticket to review first, when the caller already knows it. */
  initialCanonical?: string;
  /** Opens on the separate dependency review rather than on marking a duplicate. */
  startSeparate?: boolean;
  refresh: () => Promise<void>;
  /** Called after the duplicate and its dependency changes are saved. */
  onDone?: () => void;
  /** Called when Cancel discards the review (Escape keeps it). */
  onCancel?: () => void;
  /** Reconcile a possibly committed write without treating it as confirmed success. */
  onApplyFailure?: () => Promise<void>;
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
  const [applying, setApplying] = useState(false);
  const [attempt, setAttempt] = useState<{ key: string; id: string } | null>(
    null,
  );
  const separate = startSeparate;

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

  function changeCanonical() {
    setPreview(null);
    setCanonicalTicket(null);
    setChoices([]);
    setError("");
    setStale("");
    setTimeout(() => canonicalInput.current?.focus());
  }

  async function apply() {
    if (!preview || pending) return;
    const key = JSON.stringify({ target, preview, choices, separate });
    const id = attempt?.key === key ? attempt.id : crypto.randomUUID();
    setAttempt({ key, id });
    setPending(true);
    setApplying(true);
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
      await refresh();
      setAttempt(null);
      canonicalDrafts.delete(ticket.reference);
      onDone?.();
      onOpenChange(false);
    } catch (reason) {
      const failure = toFailure(reason);
      const kind = staleKind(failure.code);
      if (kind) setStale(kind);
      else setError(failure.message);
      try {
        await onApplyFailure?.();
      } catch {
        // Keep the write's error and request identity when its saved state cannot be read.
      }
    } finally {
      setPending(false);
      setApplying(false);
    }
  }

  const shownError = error || (answer?.key === answerKey ? answer.failure : "");
  const complete = !!preview && choices.every((choice) => choice);
  const reviewing = !!preview && (!!canonicalTicket || separate);
  const blockedReason = !reviewing
    ? pending
      ? "Loading the review…"
      : separate
        ? "Choose the existing endpoint to review"
        : "Choose the canonical ticket to review"
    : pending
      ? "Working…"
      : stale
        ? "Refresh the preview to apply"
        : evaluating
          ? "Checking the result…"
          : !complete
            ? "Choose Replace, Keep or Remove for each dependency"
            : null;
  return (
    <DialogShell
      busy={applying}
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      primaryLabel={
        separate
          ? "Apply dependency changes"
          : reviewing
            ? applyLabel(choices)
            : "Mark duplicate"
      }
      blockedReason={blockedReason}
      width={713}
      footerNote="Nothing changes until you apply."
      onSubmit={() => void apply()}
      onCancel={() => {
        canonicalDrafts.delete(ticket.reference);
        onCancel?.();
      }}
      {...(returnFocus && { returnFocus })}
    >
      <div className="duplicate-review" aria-label="Duplicate review">
        {ticket.duplicate_of && (
          <p className="duplicate-note">
            {ticket.reference} is already a duplicate of {ticket.duplicate_of}.
            Marking it again changes the canonical ticket.
          </p>
        )}
        {reviewing && preview ? (
          <>
            <div className="duplicate-scroll">
              {separate && (
                <p className="duplicate-note">
                  Replace {target} with {ticket.reference} in each dependency
                  below.
                </p>
              )}
              <div className="duplicate-canonical-field">
                <span
                  className="duplicate-field-label"
                  id={`canonical-label-${ticket.id}`}
                >
                  {separate ? "Existing endpoint" : "Canonical ticket"}
                </span>
                <div
                  className="duplicate-canonical"
                  role="group"
                  aria-labelledby={`canonical-label-${ticket.id}`}
                >
                  {canonicalTicket ? (
                    <>
                      <StatusIcon
                        status={canonicalTicket.status}
                        size={16}
                        decorative
                      />
                      <span className="duplicate-canonical-reference">
                        {canonicalTicket.reference}
                      </span>
                      <span className="duplicate-canonical-title">
                        {canonicalTicket.title}
                      </span>
                    </>
                  ) : (
                    <span className="duplicate-canonical-title">{target}</span>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="duplicate-change"
                    disabled={pending}
                    aria-label={
                      separate
                        ? "Change existing endpoint"
                        : "Change canonical ticket"
                    }
                    onClick={() => changeCanonical()}
                  >
                    Change
                  </Button>
                </div>
                {canonicalTicket && !separate && (
                  <p
                    className="duplicate-result"
                    role="group"
                    aria-label="Duplicate"
                  >
                    <StatusIcon status="Duplicate" size={14} decorative />
                    <span>
                      Result: {ticket.reference} becomes{" "}
                      <span className="duplicate-result-value">
                        Duplicate of {preview.canonical}
                      </span>
                    </span>
                  </p>
                )}
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
                  <h3>
                    Dependencies to review{" "}
                    <span className="dependencies-count">
                      {preview.edges.length}
                    </span>
                  </h3>
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
                              <span className="dependency-ref">
                                {edge.blocker}
                              </span>{" "}
                              blocks{" "}
                              <span className="dependency-ref">
                                {edge.dependent}
                              </span>
                            </span>
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
                          </div>
                          <SegmentedControl<Unchosen>
                            aria-label={`Choice for ${name}`}
                            compact
                            value={choice}
                            onValueChange={(next) =>
                              setChoices((current) =>
                                current.map((value, i) =>
                                  i === index ? next : value,
                                ),
                              )
                            }
                            options={(
                              ["replace", "retain", "remove"] as const
                            ).map((value) => ({
                              value,
                              label:
                                value === "replace"
                                  ? `Replace with ${separate ? ticket.reference : preview.canonical}`
                                  : choiceLabels[value],
                              disabled:
                                !!stale || (value === "replace" && !!issue),
                              ...(value === "replace" && reason
                                ? { title: reason }
                                : {}),
                            }))}
                          />
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
              <p className="sr-only">
                {separate
                  ? "All of the chosen changes are applied together or not at all."
                  : summarize(ticket.reference, preview.canonical, choices)}
              </p>
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
          </>
        ) : (
          <div className="duplicate-form">
            <FieldGroup>
              <Field data-invalid={!!error}>
                <FieldLabel htmlFor={`canonical-${ticket.id}`}>
                  {separate
                    ? "Existing endpoint to replace"
                    : "Canonical ticket"}
                </FieldLabel>
                <Input
                  ref={canonicalInput}
                  id={`canonical-${ticket.id}`}
                  value={canonical}
                  onChange={(event) => setCanonical(event.target.value)}
                  onKeyDown={(event) => {
                    // Enter reviews the typed reference; the footer's primary
                    // stays disabled until a review is open.
                    if (event.key !== "Enter" || event.nativeEvent.isComposing)
                      return;
                    event.preventDefault();
                    if (target && !pending) void loadPreview();
                  }}
                  placeholder="Search by title or T-number"
                  autoComplete="off"
                  aria-label={
                    separate
                      ? "Existing endpoint to replace"
                      : "Canonical ticket reference"
                  }
                  aria-invalid={!!error}
                />
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
                          <StatusIcon
                            status={item.status}
                            size={14}
                            decorative
                          />
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
          </div>
        )}
      </div>
    </DialogShell>
  );
}
