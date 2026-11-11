import { Fragment, useEffect, useId, useState } from "react";
import { Pencil } from "lucide-react";
import { RadioGroup } from "radix-ui";
import { Button } from "@/components/ui/button";
import { DialogShell } from "@/components/ui/dialog-shell";
import { Textarea } from "@/components/ui/textarea";
import {
  syncReview,
  type Conflict,
  type ConflictSummary,
  type Resolution,
} from "@/lib/sync-review-api";
import { FieldValue } from "./FieldValue";
import { conflictLabel, dayTime } from "./labels";
import "@/features/settings/settings.css";
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
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    syncReview.conflict({ kind, id }).then(
      (loaded) => {
        if (active) setConflict(loaded);
      },
      (reason: unknown) => {
        if (active) setError(String(reason));
      },
    );
    return () => {
      active = false;
    };
  }, [kind, id]);
  const choiceOf = (field: string): Choice => choices[field] ?? "local";
  async function save() {
    if (!conflict) return;
    setBusy(true);
    setError("");
    try {
      await syncReview.resolve(
        { kind, id },
        conflict.fields.map(({ field }): Resolution => {
          const choice = choiceOf(field);
          return choice === "edited"
            ? { field, choice, value: drafts[field] ?? "" }
            : { field, choice };
        }),
      );
      onResolved?.();
      onClose();
    } catch (reason) {
      setError(String(reason));
      setBusy(false);
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
      cancelLabel="Later"
      blockedReason={conflict ? null : error ? "" : "Loading both versions…"}
      footerNote="This desktop’s version stays until you save."
      onSubmit={() => void save()}
      width={760}
      busy={busy}
    >
      {error && <p role="alert">{error}</p>}
      {conflict && (
        <div className="sync-compare">
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
                <RadioGroup.Root
                  className="sync-compare-choices"
                  aria-labelledby={`${ids}-${field}`}
                  value={choice}
                  disabled={busy}
                  onValueChange={(value) =>
                    setChoices({ ...choices, [field]: value as Choice })
                  }
                >
                  <RadioGroup.Item
                    value="local"
                    className="upload-destination-choice"
                    aria-label={`${label} from this desktop${body ? "" : `: ${local}`}`}
                  >
                    <span className="layout-choice-dot" aria-hidden="true" />
                    <span>
                      <FieldValue
                        field={field}
                        value={local}
                        against={remote}
                      />
                    </span>
                  </RadioGroup.Item>
                  <RadioGroup.Item
                    value="remote"
                    className="upload-destination-choice"
                    aria-label={`${label} from ${remote_device}${body ? "" : `: ${remote}`}`}
                  >
                    <span className="layout-choice-dot" aria-hidden="true" />
                    <span>
                      <FieldValue
                        field={field}
                        value={remote}
                        against={local}
                      />
                    </span>
                  </RadioGroup.Item>
                  {body && (
                    <div className="sync-result">
                      {choice === "edited" ? (
                        <>
                          <RadioGroup.Item
                            value="edited"
                            className="upload-destination-choice"
                            aria-label={`Your edited ${label.toLowerCase()}`}
                          >
                            <span
                              className="layout-choice-dot"
                              aria-hidden="true"
                            />
                            <span>Your edit</span>
                          </RadioGroup.Item>
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
                </RadioGroup.Root>
              </Fragment>
            );
          })}
        </div>
      )}
    </DialogShell>
  );
}
