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
  PublicationResolution,
  PublicationReview,
} from "@/lib/api/publication";
import { sourcesClient, toSourceFailure } from "@/lib/api/sources";
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
  }, [attempt.reference, attempt.id]);

  async function resolve(resolution: PublicationResolution) {
    setBusy(true);
    setError("");
    try {
      await sourcesClient.resolvePublication(attempt.reference, resolution);
      await refresh();
      close();
    } catch (reason) {
      // The attempt is unchanged: show why, keep the review open.
      setError(toSourceFailure(reason).message);
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
          <h4>What is known</h4>
          <ul>
            {review.known.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
        <section aria-label="Unknown">
          <h4>What is not known</h4>
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
          Only part of the recent issues in {attempt.destination} could be read,
          so nothing can be ruled out yet.
        </p>
      )}
      {review.candidates.length > 0 && (
        <section aria-label="Possible matches" className="publication-field">
          <span className="publication-label">
            Issues in {attempt.destination} that may be this one
          </span>
          <ul className="publication-candidates">
            {review.candidates.map((candidate) => (
              <li key={candidate.identity.id}>
                <a href={candidate.url} target="_blank" rel="noreferrer">
                  {candidate.display}
                </a>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void resolve({ kind: "attach", issue: candidate.locator })
                  }
                >
                  This is it
                </Button>
              </li>
            ))}
          </ul>
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
