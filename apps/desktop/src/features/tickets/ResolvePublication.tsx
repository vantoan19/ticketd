import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type {
  PublicationAttempt,
  PublicationCandidate,
  PublicationResolution,
  PublicationReview,
} from "@/lib/api/publication";
import { toFailure } from "@/lib/api/bridge-failure";
import { FailureDetails } from "@/components/ui/failure-alert";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { sourcesClient } from "@/lib/api/sources";
import { SourceLink } from "./SourceLink";
import "./publication.css";

/**
 * Reviews an unresolved publication and settles it. The core decides what is
 * known and which actions are safe; this only shows that and sends the person's
 * choice. Nothing here can create another issue: a blind retry is not offered.
 */
export function AttemptReview({
  attempt,
  open,
  onOpenChange,
  refresh,
}: {
  attempt: PublicationAttempt;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  refresh: () => Promise<void>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Its decisions live in the review itself, so the header's close is
          the only way out (no X plus a second Close). */}
      <DialogContent className="publication-dialog" showCloseButton={false}>
        <DialogHeader showCloseButton>
          <DialogTitle>Publication unresolved</DialogTitle>
          <DialogDescription>
            {attempt.reference} stays a local ticket. Nothing was attached to
            it.
          </DialogDescription>
        </DialogHeader>
        {open && (
          <ReviewBody
            attempt={attempt}
            close={() => onOpenChange(false)}
            refresh={refresh}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

type Load =
  | { kind: "loading" }
  | { kind: "ready"; review: PublicationReview }
  | { kind: "failed"; failure: FailureDescription };

export type PublicationRetryTarget = {
  connectionId: string;
  destination: string;
};

export function ReviewBody({
  attempt,
  close,
  refresh,
  inline = false,
}: {
  inline?: boolean;
  attempt: PublicationAttempt;
  close: (retry?: PublicationRetryTarget) => void;
  refresh: () => Promise<void>;
}) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [issue, setIssue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FailureDescription | null>(null);
  // An attach the core refused because the issue's text differs from what was
  // sent. It is repeated only when the person confirms the difference.
  const [different, setDifferent] = useState<{
    resolution: PublicationResolution;
    failure: FailureDescription;
  } | null>(null);
  const [round, setRound] = useState(0);
  const [linking, setLinking] = useState(false);
  const [dismissed, setDismissed] = useState<string[]>([]);
  function checkAgain() {
    setDismissed([]);
    setLoad({ kind: "loading" });
    setRound((n) => n + 1);
  }

  useEffect(() => {
    let active = true;
    sourcesClient.reviewPublication(attempt.reference, true).then(
      (review) => {
        if (active) setLoad({ kind: "ready", review });
      },
      (reason: unknown) => {
        if (active)
          setLoad({
            kind: "failed",
            failure: describeFailure(reason, "review the publication"),
          });
      },
    );
    return () => {
      active = false;
    };
  }, [attempt.reference, attempt.id, round]);

  async function resolve(
    resolution: PublicationResolution,
    acceptDifferentContent = false,
  ) {
    setBusy(true);
    setError(null);
    setDifferent(null);
    try {
      const { attempt: settled } = await sourcesClient.resolvePublication(
        attempt.reference,
        resolution,
        { acceptDifferentContent },
      );
      await refresh();
      const connectionId =
        load.kind === "ready" ? load.review.connection_id : undefined;
      close(
        resolution.kind === "not_created" &&
          settled.id === attempt.id &&
          connectionId
          ? { connectionId, destination: settled.destination }
          : undefined,
      );
    } catch (reason) {
      // The attempt is unchanged: show why, keep the review open.
      const failure = toFailure(reason);
      if (failure.code === "publication_different_content")
        setDifferent({
          resolution,
          failure: describeFailure(failure, "attach this issue"),
        });
      else setError(describeFailure(reason, "resolve this publication"));
    } finally {
      setBusy(false);
    }
  }

  if (load.kind === "loading")
    return (
      <p role="status">
        Reading the attempt and looking in{" "}
        {attempt.destination_label ?? attempt.destination}…
      </p>
    );
  if (load.kind === "failed")
    return (
      <p className="publication-error" role="alert">
        {load.failure.title}. {load.failure.sentence}
        <FailureDetails variant="popover" details={load.failure.details} />
        <Button variant="ghost" size="sm" onClick={checkAgain}>
          Check again
        </Button>
      </p>
    );

  const { review } = load;
  const name = review.provider_name;
  const known = review.attempt.issue;
  const attach = review.actions.find((a) => a.kind === "attach");
  const notCreated = review.actions.find((a) => a.kind === "not_created");
  if (inline)
    return (
      <>
        <div className="publication-candidate-panel">
          <p className="publication-detail">
            {review.lookup_failure ? (
              <>
                {name} could not be checked.{" "}
                {
                  describeFailure(
                    review.lookup_failure,
                    "check publication matches",
                  ).sentence
                }
                <FailureDetails
                  variant="popover"
                  small
                  details={review.lookup_failure.message}
                />
              </>
            ) : (
              `Checked ${name} just now · ${review.candidates.length} possible ${review.candidates.length === 1 ? "match" : "matches"}`
            )}
          </p>
          {review.candidates
            .filter((candidate) => !dismissed.includes(candidate.identity.id))
            .map((candidate) => (
              <article
                key={candidate.identity.id}
                className="publication-candidate-card"
              >
                <SourceLink url={candidate.url} className="source-number">
                  {candidate.display}
                </SourceLink>
                <h4>{candidate.title}</h4>
                <div className="publication-inline-actions">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !attach?.available}
                    onClick={() =>
                      void resolve({ kind: "attach", issue: candidate.locator })
                    }
                  >
                    This is it — link it
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      setDismissed((current) => [
                        ...current,
                        candidate.identity.id,
                      ])
                    }
                  >
                    Not this one
                  </Button>
                  <SourceLink url={candidate.url}>
                    Open on {review.provider_name}
                  </SourceLink>
                </div>
              </article>
            ))}
          {known && (
            <p>
              <SourceLink url={known.url} className="source-number">
                {known.display}
              </SourceLink>{" "}
              was created for this attempt.{" "}
              <Button
                size="sm"
                disabled={busy || !attach?.available}
                onClick={() => void resolve({ kind: "attach", issue: null })}
              >
                Link this issue
              </Button>
            </p>
          )}
        </div>
        <div className="publication-inline-actions">
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={checkAgain}
          >
            Check again
          </Button>
          <Button
            variant="link"
            size="sm"
            disabled={busy || !attach?.available}
            onClick={() => setLinking(!linking)}
          >
            Link a different issue…
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !notCreated?.available}
            title={notCreated?.detail}
            aria-describedby={`publication-retry-${attempt.id}`}
            onClick={() => void resolve({ kind: "not_created" })}
          >
            Publish again
          </Button>
        </div>
        <p
          id={`publication-retry-${attempt.id}`}
          className="publication-detail"
        >
          {notCreated?.detail ??
            "Publish again unlocks once a check finds no matching issue."}
        </p>
        {linking && (
          <form
            className="publication-attach"
            onSubmit={(event) => {
              event.preventDefault();
              if (issue.trim())
                void resolve({ kind: "attach", issue: issue.trim() });
            }}
          >
            <Input
              aria-label="Issue number or link"
              placeholder="Issue number or link"
              value={issue}
              onChange={(event) => setIssue(event.target.value)}
            />
            <Button size="sm" disabled={busy || !issue.trim()}>
              Link issue
            </Button>
          </form>
        )}
        {different && (
          <div className="publication-error" role="alert">
            <p>
              {different.failure.sentence}
              <FailureDetails
                variant="popover"
                details={different.failure.details}
              />
            </p>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void resolve(different.resolution, true)}
            >
              Attach anyway
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setDifferent(null)}
            >
              Do not attach
            </Button>
          </div>
        )}
        {error && (
          <p className="publication-error" role="alert">
            {error.title}. {error.sentence}
            <FailureDetails variant="popover" details={error.details} />
          </p>
        )}
      </>
    );
  return (
    <>
      <div className="publication-facts">
        <section aria-label="Known">
          <h3>What is known</h3>
          <ul>
            {review.known.map((line) => (
              <li key={line}>
                {known && line.includes(known.url) ? (
                  <>
                    <SourceLink url={known.url}>{known.display}</SourceLink> was
                    created for this attempt.
                  </>
                ) : (
                  line
                )}
              </li>
            ))}
          </ul>
        </section>
        <section aria-label="Unknown">
          <h3>What is not known</h3>
          <ul>
            <li>
              {review.unknown.charAt(0).toUpperCase() + review.unknown.slice(1)}
            </li>
          </ul>
        </section>
      </div>
      {review.lookup_failure && (
        <p className="publication-detail" role="status">
          {name} could not be searched just now.{" "}
          {
            describeFailure(review.lookup_failure, "check publication matches")
              .sentence
          }{" "}
          That does not mean nothing was created.
          <FailureDetails
            variant="popover"
            small
            details={review.lookup_failure.message}
          />
        </p>
      )}
      {review.candidates_complete === false && (
        <p className="publication-detail" role="status">
          Nothing can be ruled out yet.
        </p>
      )}
      <Button variant="ghost" size="sm" disabled={busy} onClick={checkAgain}>
        Check again
      </Button>
      <Candidates
        label={`Issues in ${attempt.destination_label ?? attempt.destination} that match what was sent`}
        candidates={review.candidates}
        busy={busy}
        attach={(candidate) =>
          void resolve({ kind: "attach", issue: candidate.locator })
        }
      />
      <Candidates
        label={`Other recent issues from your account in ${attempt.destination_label ?? attempt.destination} (these do not block confirming that nothing was created)`}
        candidates={review.other_recent}
        busy={busy}
        attach={(candidate) =>
          void resolve({ kind: "attach", issue: candidate.locator })
        }
      />
      {different && (
        <section
          aria-label="Confirm a different issue"
          className="publication-field"
        >
          <p className="publication-error" role="alert">
            {different.failure.sentence}
            <FailureDetails
              variant="popover"
              details={different.failure.details}
            />
          </p>
          <div className="publication-attach">
            <Button
              disabled={busy}
              onClick={() => void resolve(different.resolution, true)}
            >
              Attach anyway
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setDifferent(null)}
            >
              Do not attach
            </Button>
          </div>
        </section>
      )}
      {attach?.available && (
        <section
          aria-label="Attach the created issue"
          className="publication-field"
        >
          <span className="publication-label">{attach.label}</span>
          {known ? (
            <Button
              disabled={busy}
              onClick={() => void resolve({ kind: "attach", issue: null })}
            >
              Attach {known.display}
            </Button>
          ) : (
            <form
              className="publication-attach"
              onSubmit={(event) => {
                event.preventDefault();
                if (issue.trim())
                  void resolve({ kind: "attach", issue: issue.trim() });
              }}
            >
              <Input
                aria-label="Issue number or link"
                placeholder="Issue number or link"
                value={issue}
                onChange={(event) => setIssue(event.target.value)}
                disabled={busy}
              />
              <Button type="submit" disabled={busy || !issue.trim()}>
                Attach issue
              </Button>
            </form>
          )}
          <p className="publication-detail">{attach.detail}</p>
        </section>
      )}
      {attach && !attach.available && (
        <p className="publication-detail">{attach.detail}</p>
      )}
      {notCreated && (
        <section aria-label="Nothing was created" className="publication-field">
          <Button
            variant="outline"
            disabled={busy || !notCreated.available}
            onClick={() => void resolve({ kind: "not_created" })}
          >
            {notCreated.label}
          </Button>
          <p className="publication-detail">{notCreated.detail}</p>
        </section>
      )}
      {error && (
        <p className="publication-error" role="alert">
          {error.title}. {error.sentence}
          <FailureDetails variant="popover" details={error.details} />
        </p>
      )}
      <p className="publication-detail">{review.note}</p>
    </>
  );
}

/** Issues that may be this publication's result, each with why it is listed. */
function Candidates({
  label,
  candidates,
  busy,
  attach,
}: {
  label: string;
  candidates: PublicationCandidate[];
  busy: boolean;
  attach: (candidate: PublicationCandidate) => void;
}) {
  if (candidates.length === 0) return null;
  return (
    <section aria-label={label} className="publication-field">
      <span className="publication-label">{label}</span>
      <ul className="publication-candidates">
        {candidates.map((candidate) => (
          <li key={candidate.identity.id}>
            <span>
              <SourceLink url={candidate.url}>{candidate.display}</SourceLink>{" "}
              {candidate.title && <strong>{candidate.title}</strong>}
              <span className="publication-detail">
                {" "}
                Created {formatCreated(candidate.created_at)}.{" "}
                {candidate.reason === "content_match"
                  ? "Its title or description matches what was sent."
                  : "Created by your account around that time."}
              </span>
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              aria-label={`This is ${candidate.display}`}
              onClick={() => attach(candidate)}
            >
              This is it
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function formatCreated(value: string): string {
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? value : time.toLocaleString();
}
