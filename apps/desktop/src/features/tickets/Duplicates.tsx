import { useRef, useState, type FormEvent } from "react";
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
} from "@/lib/api/client";
import { toFailure } from "@/lib/api/bridge-failure";
import "./duplicate-review.css";

type Unchosen = Choice | "";

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
}: {
  ticket: Ticket;
  /** Opens on the separate dependency review rather than on marking a duplicate. */
  startSeparate?: boolean;
  refresh: () => Promise<void>;
  /** Called after the duplicate and its dependency changes are saved. */
  onDone?: () => void;
  onCancel?: () => void;
}) {
  const canonicalInput = useRef<HTMLInputElement>(null);
  const [canonical, setCanonical] = useState("");
  const [preview, setPreview] = useState<DuplicatePreview | null>(null);
  const [canonicalTicket, setCanonicalTicket] = useState<Ticket | null>(null);
  const [choices, setChoices] = useState<Unchosen[]>([]);
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const [pending, setPending] = useState(false);
  const [attempt, setAttempt] = useState<{ key: string; id: string } | null>(
    null,
  );
  const [separate, setSeparate] = useState(startSeparate);
  const target = canonical.trim();
  // Separate review replaces an existing endpoint with this ticket, after its duplicate link was removed.
  const sourceRef = separate ? target : ticket.reference;

  async function loadPreview() {
    setPending(true);
    setError("");
    setStale(false);
    try {
      const result = await client.previewDuplicate(
        sourceRef,
        separate ? ticket.reference : target,
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
    setStale(false);
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
      onDone?.();
    } catch (reason) {
      const failure = toFailure(reason);
      if (failure.code === "review_changed") setStale(true);
      else setError(failure.message);
    } finally {
      setPending(false);
    }
  }

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
          {separate && (
            <p className="duplicate-note">
              Replace {target} with {ticket.reference} in each dependency below.
            </p>
          )}
          {canonicalTicket && (
            <div className="duplicate-tickets">
              <TicketSummary
                label="Duplicate"
                ticket={ticket}
                icon="Canceled"
                note={`${ticket.status} → Canceled · Duplicate of ${preview.canonical}`}
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
                {target} is itself a duplicate, so {ticket.reference} points to{" "}
                {preview.canonical}.
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
                  : "A canceled ticket never satisfies a blocking dependency, so each of these needs a decision."}
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
                          <span className="dependency-edge-label">Current</span>{" "}
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
                        options={(["replace", "remove", "retain"] as const).map(
                          (value) => ({
                            value,
                            label: choiceLabels[value],
                            disabled: value === "replace" && !!issue,
                            ...(value === "replace" && reason
                              ? { title: reason }
                              : {}),
                          }),
                        )}
                      />
                      {reason && <p className="dependency-reason">{reason}.</p>}
                      <p className="dependency-consequence">
                        {choice
                          ? consequence(sourceRef, edge, choice, separate)
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
              Dependency changes are reviewed separately then.
            </p>
          )}
          {stale && (
            <div role="alert" className="duplicate-stale">
              <p>
                Dependencies changed after this preview, so nothing was applied.
                Refresh the preview to review the current dependencies.
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
          {error && (
            <p role="alert" className="duplicate-error">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              disabled={pending || stale || !complete}
              onClick={() => void apply()}
            >
              {separate ? "Apply dependency changes" : applyLabel(choices)}
            </Button>
          </DialogFooter>
        </>
      ) : (
        <form onSubmit={submit} className="relationship-form">
          <FieldGroup>
            <Field data-invalid={!!error}>
              <FieldLabel htmlFor={`canonical-${ticket.id}`}>
                {separate
                  ? "Existing endpoint to replace"
                  : "Canonical ticket reference"}
              </FieldLabel>
              <div className="relationship-input">
                <Input
                  ref={canonicalInput}
                  id={`canonical-${ticket.id}`}
                  value={canonical}
                  onChange={(event) => setCanonical(event.target.value)}
                  placeholder="T-1"
                  required
                  aria-invalid={!!error}
                />
                <Button type="submit" variant="outline" disabled={pending}>
                  Review dependencies
                </Button>
              </div>
              <FieldError>{error}</FieldError>
            </Field>
          </FieldGroup>
          <Button
            type="button"
            variant="link"
            className="duplicate-change"
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
