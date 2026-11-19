import { Fragment, useEffect, useId, useRef, useState } from "react";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ChoiceTile, ChoiceTiles } from "@/components/ui/choice-tiles";
import { FailureAlert } from "@/components/ui/failure-alert";
import { DialogShell } from "@/components/ui/dialog-shell";
import { Textarea } from "@/components/ui/textarea";
import { toFailure } from "@/lib/api/bridge-failure";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import {
  syncReview,
  type Conflict,
  type ConflictSummary,
  type Resolution,
} from "@/lib/sync-review-api";
import { FieldValue } from "./FieldValue";
import { conflictLabel, dayTime } from "./labels";
import { useConflicts } from "./use-conflicts";
import { useRequestIds } from "./use-request-ids";
import "./sync-review.css";

type Choice = Resolution["choice"];

/** The latest known change time, or `otherwise` when none was recorded. */
const latest = (times: (string | null)[], otherwise: string) =>
  times.reduce<string>((a, b) => (b && b > a ? b : a), "") || otherwise;

/**
 * The comparison of a record's conflicting fields: this desktop's value beside
 * the other desktop's, one choice per field. This desktop's value is selected
 * to begin with because it is the one kept until the person decides.
 */
export function ConflictReview({
  conflict: summary,
  onClose,
  onResolved,
}: {
  conflict: ConflictSummary;
  onClose: () => void;
  onResolved?: () => void;
}) {
  const ids = useId();
  const { kind, id } = summary;
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  // One edit draft per field: two texts can be edited in the same review.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // A failure in plain words, or what the review found; shown above the footer.
  const [error, setError] = useState<FailureDescription | string>("");
  const [busy, setBusy] = useState(false);
  // Set at once, where `busy` waits for a render: a second submit finds it.
  const saving = useRef(false);
  const requestId = useRequestIds();
  useEffect(() => {
    let active = true;
    syncReview.conflict({ kind, id }).then(
      (loaded) => {
        if (active) setConflict(loaded);
      },
      (reason: unknown) => {
        if (active) setError(describeFailure(reason, "load both versions"));
      },
    );
    return () => {
      active = false;
    };
  }, [kind, id]);
  // A newer change from another desktop can settle the record while this is
  // open. The review then says so in place: it was listed and no longer is.
  const { conflicts } = useConflicts();
  const listed = conflicts.some((item) => item.kind === kind && item.id === id);
  const [wasListed, setWasListed] = useState(false);
  if (listed && !wasListed) setWasListed(true);
  // Not while saving: the person's own save also takes it off the list.
  const withdrawn = wasListed && !listed && !busy;
  // The keyboard starts on the first choice, not on the footer.
  const compare = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (conflict)
      compare.current?.querySelector<HTMLElement>('[role="radio"]')?.focus();
  }, [conflict]);
  const choiceOf = (field: string): Choice => choices[field] ?? "local";
  async function save() {
    if (!conflict || saving.current) return;
    saving.current = true;
    setBusy(true);
    setError("");
    const resolutions = conflict.fields.map(
      ({ field, detected_at }): Resolution => {
        const choice = choiceOf(field);
        return choice === "edited"
          ? { field, choice, value: drafts[field] ?? "", detected_at }
          : { field, choice, detected_at };
      },
    );
    try {
      await syncReview.resolve(
        { kind, id },
        resolutions,
        requestId(resolutions),
      );
      onResolved?.();
      onClose();
    } catch (reason) {
      const failure = toFailure(reason);
      if (failure.code === "review_changed") await reload();
      else setError(describeFailure(failure, "save your choices"));
      saving.current = false;
      setBusy(false);
    }
  }
  /** Shows the values as they are now, after a save found them changed. */
  async function reload() {
    try {
      setConflict(await syncReview.conflict({ kind, id }));
      // A side was picked on a value that is no longer the one shown.
      setChoices((made) =>
        Object.fromEntries(
          Object.entries(made).filter(([, choice]) => choice === "edited"),
        ),
      );
      setError(
        "The values changed while you were reviewing. Check them and save again.",
      );
    } catch {
      setConflict(null);
      setError(
        "Nothing is left to review here: the values were settled meanwhile.",
      );
      onResolved?.();
    }
  }
  const now = new Date();
  const fields = conflict?.fields ?? [];
  const devices = [...new Set(fields.map((field) => field.remote_device))];
  return (
    <DialogShell
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Review changes"
      description={[summary.reference, summary.title]
        .filter(Boolean)
        .join(" · ")}
      primaryLabel="Save"
      cancelLabel={withdrawn ? "Close" : "Later"}
      blockedReason={
        withdrawn ? "" : conflict ? null : error ? "" : "Loading both versions…"
      }
      footerNote="This desktop’s version is used until you save or a newer change arrives."
      onSubmit={() => void save()}
      size="lg"
      busy={busy}
      primaryFirst
      {...(error &&
        !withdrawn && {
          error:
            typeof error === "string" ? (
              error
            ) : (
              <FailureAlert size="compact" failure={error} />
            ),
        })}
    >
      {withdrawn ? (
        <p role="status">
          A newer change settled this while it was open, so nothing is left to
          review.
        </p>
      ) : null}
      {conflict && !withdrawn && (
        <div className="sync-compare" ref={compare}>
          <span />
          <div className="sync-compare-head">
            <strong>This desktop</strong>
            <span>
              {conflict.local_device} ·{" "}
              {dayTime(
                latest(
                  fields.map((field) => field.local_changed_at),
                  conflict.detected_at,
                ),
                now,
              ).replace(/^[TY]/, (letter) => letter.toLowerCase())}
            </span>
          </div>
          <div className="sync-compare-head">
            <strong>{devices.join(", ")}</strong>
            <span>
              {dayTime(
                latest(
                  fields.map((field) => field.remote_changed_at),
                  conflict.detected_at,
                ),
                now,
              )}
            </span>
          </div>
          {fields.map(({ field, section, local, remote, remote_device }) => {
            const label = conflictLabel(kind, { field, section }, now);
            const body = field === "body" || field.endsWith(":body");
            const choice = choiceOf(field);
            return (
              <Fragment key={field}>
                <div className="sync-compare-field" id={`${ids}-${field}`}>
                  {label}
                </div>
                {/* One ChoiceTiles group per field: this desktop's value
                    beside the other one (set SR-10). */}
                <div className="sync-compare-choices">
                  <ChoiceTiles
                    aria-labelledby={`${ids}-${field}`}
                    value={choice}
                    disabled={busy}
                    onValueChange={(value) =>
                      setChoices({ ...choices, [field]: value as Choice })
                    }
                  >
                    <ChoiceTile
                      value="local"
                      aria-label={`${label} from this desktop${body ? "" : `: ${local || "empty"}`}`}
                      title={
                        <FieldValue
                          field={field}
                          value={local}
                          against={remote}
                        />
                      }
                    />
                    <ChoiceTile
                      value="remote"
                      aria-label={`${label} from ${remote_device}${body ? "" : `: ${remote || "empty"}`}`}
                      title={
                        <FieldValue
                          field={field}
                          value={remote}
                          against={local}
                        />
                      }
                    />
                    {body && choice === "edited" && (
                      <ChoiceTile
                        value="edited"
                        aria-label={`Your edited ${label.toLowerCase()}`}
                        title="Your edit"
                      />
                    )}
                  </ChoiceTiles>
                  {/* An Automation's steps are taken whole from one desktop. */}
                  {body && kind !== "automation" && (
                    <div className="sync-result">
                      {choice === "edited" ? (
                        <>
                          <Textarea
                            autoFocus
                            aria-label={`Edited ${label.toLowerCase()}`}
                            value={drafts[field] ?? ""}
                            disabled={busy}
                            onChange={(event) =>
                              setDrafts({
                                ...drafts,
                                [field]: event.target.value,
                              })
                            }
                          />
                        </>
                      ) : (
                        <div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={busy}
                            onClick={() => {
                              // The edit starts from the side that was selected.
                              setDrafts({
                                ...drafts,
                                [field]: choice === "remote" ? remote : local,
                              });
                              setChoices({ ...choices, [field]: "edited" });
                            }}
                          >
                            <Pencil />
                            Edit instead
                          </Button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </Fragment>
            );
          })}
        </div>
      )}
    </DialogShell>
  );
}
