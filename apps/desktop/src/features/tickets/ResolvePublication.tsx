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
import { Input } from "@/components/ui/input";
import type {
  PublicationAttempt,
  PublicationCandidate,
  PublicationResolution,
  PublicationReview,
} from "@/lib/api/publication";
import { toFailure } from "@/lib/api/bridge-failure";
import { sourcesClient, toSourceFailure } from "@/lib/api/sources";
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
      <DialogContent className="publication-dialog">
        <DialogHeader>
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
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  );
}

type Load =
  | { kind: "loading" }
  | { kind: "ready"; review: PublicationReview }
  | { kind: "failed"; message: string };

function ReviewBody({
  attempt,
  close,
  refresh,
}: {
  attempt: PublicationAttempt;
  close: () => void;
  refresh: () => Promise<void>;
}) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [issue, setIssue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // An attach the core refused because the issue's text differs from what was
  // sent. It is repeated only when the person confirms the difference.
  const [different, setDifferent] = useState<{
    resolution: PublicationResolution;
    message: string;
  } | null>(null);
  const [round, setRound] = useState(0);

  useEffect(() => {
    let active = true;
    sourcesClient.reviewPublication(attempt.reference, true).then(
      (review) => {
        if (active) setLoad({ kind: "ready", review });
      },
      (reason: unknown) => {
        if (active)
          setLoad({ kind: "failed", message: toSourceFailure(reason).message });
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
    setError("");
    setDifferent(null);
    try {
      await sourcesClient.resolvePublication(attempt.reference, resolution, {
        acceptDifferentContent,
      });
      await refresh();
      close();
    } catch (reason) {
      // The attempt is unchanged: show why, keep the review open.
      const failure = toFailure(reason);
      if (failure.code === "publication_different_content")
        setDifferent({ resolution, message: failure.message });
      else setError(toSourceFailure(reason).message);
    } finally {
      setBusy(false);
    }
  }

  if (load.kind === "loading")
    return (
      <p role="status">
        Reading the attempt and looking in {attempt.destination}…
      </p>
    );
  if (load.kind === "failed")
    return (
      <p className="publication-error" role="alert">
        {load.message}
      </p>
    );

  const { review } = load;
  const name = review.provider_name;
  const known = review.attempt.issue;
  const attach = review.actions.find((a) => a.kind === "attach");
  const notCreated = review.actions.find((a) => a.kind === "not_created");
  return (
    <>
      <div className="publication-facts">
        <section aria-label="Known">
          <h3>What is known</h3>
          <ul>
            {review.known.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
        <section aria-label="Unknown">
          <h3>What is not known</h3>
          <ul>
            <li>{review.unknown}</li>
          </ul>
        </section>
      </div>
      {review.lookup_failure && (
        <p className="publication-detail" role="status">
          {name} could not be searched just now ({review.lookup_failure.message}
          ). That does not mean nothing was created.
        </p>
      )}
      {review.candidates_complete === false && (
        <p className="publication-detail" role="status">
          Nothing can be ruled out yet.{" "}
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => {
              setLoad({ kind: "loading" });
              setRound((n) => n + 1);
            }}
          >
            Look again
          </Button>
        </p>
      )}
      <Candidates
        label={`Issues in ${attempt.destination} that match what was sent`}
        candidates={review.candidates}
        busy={busy}
        attach={(candidate) =>
          void resolve({ kind: "attach", issue: candidate.locator })
        }
      />
      <Candidates
        label={`Other recent issues from your account in ${attempt.destination} (these do not block confirming that nothing was created)`}
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
            {different.message}
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
          <span className="publication-label">{notCreated.label}</span>
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
          {error}
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
