import { Disclosure } from "@/components/ui/disclosure";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { DialogShell } from "@/components/ui/dialog-shell";
import {
  attachments,
  type AttachmentCleanupReview,
} from "@/lib/api/attachments";
import { FailureAlert } from "@/components/ui/failure-alert";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { formatSize } from "./format-size";
import { usageContext } from "./usage-context";

export function AttachmentCleanup({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged: () => void;
}) {
  const [rows, setRows] = useState<AttachmentCleanupReview[]>([]);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FailureDescription | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [selected, setSelected] = useState<{ id: string; requestId: string }[]>(
    [],
  );
  useEffect(() => {
    let current = true;
    void attachments
      .cleanupReviews(offset)
      .then((next) => {
        if (current) {
          setRows(next);
          setLoading(false);
        }
      })
      .catch((reason: unknown) => {
        if (current) {
          setError(describeFailure(reason, "review unused files"));
          setLoading(false);
        }
      });
    return () => {
      current = false;
    };
  }, [offset, attempt]);
  async function quarantine() {
    setBusy(true);
    setError(null);
    let completed = 0;
    try {
      for (const item of selected) {
        await attachments.quarantine(item.id, item.requestId);
        completed += 1;
        setSelected((previous) => previous.filter((row) => row.id !== item.id));
      }
      onClose();
    } catch (reason) {
      const failure = describeFailure(reason, "move the remaining files");
      setError({
        ...failure,
        sentence: `${completed ? `${completed} moved to quarantine. ` : ""}${failure.sentence} The rest stay where they are.`,
      });
    } finally {
      setBusy(false);
      onChanged();
    }
  }
  function page(next: number) {
    setSelected([]);
    setRows([]);
    setLoading(true);
    setError(null);
    setOffset(next);
  }
  function fileRow(row: AttachmentCleanupReview) {
    return (
      <li key={row.attachment.id}>
        <label>
          <input
            type="checkbox"
            aria-label={`Select ${row.attachment.display_name}`}
            disabled={busy || !row.eligible}
            checked={selected.some((item) => item.id === row.attachment.id)}
            onChange={(event) => {
              if (event.target.checked)
                setSelected((previous) => [
                  ...previous,
                  {
                    id: row.attachment.id,
                    requestId: crypto.randomUUID(),
                  },
                ]);
              else
                setSelected((previous) =>
                  previous.filter((item) => item.id !== row.attachment.id),
                );
            }}
          />
          <span>
            {row.attachment.display_name}
            <small>
              {row.attachment.size_bytes != null
                ? `${formatSize(row.attachment.size_bytes)} · `
                : ""}
              {row.attachment.kind === "local_snapshot"
                ? "Local snapshot"
                : "External reference"}
            </small>
          </span>
        </label>
        <p>
          {row.attachment.purge_state === "pending" ||
          row.attachment.purge_state === "purged"
            ? row.reason
            : row.usage.protections.length
              ? `Protected · ${usageContext(row.usage)}`
              : row.reason}
        </p>
        {row.usage.protections.length > 0 && (
          <Disclosure
            label="Protected references"
            count={row.usage.protections.length}
          >
            <ul>
              {row.usage.protections.map((use) => (
                <li key={`${use.kind}:${use.owner}`}>
                  {usageContext({ ...row.usage, protections: [use] })}
                </li>
              ))}
            </ul>
          </Disclosure>
        )}
      </li>
    );
  }
  return (
    <DialogShell
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      size="lg"
      title="Review unused attachments"
      description="Choose files to move out of your active workspace. Eligibility is checked again before cleanup."
      primaryLabel="Move to quarantine"
      blockedReason={
        busy
          ? "Moving files…"
          : loading
            ? "Reviewing files…"
            : selected.length
              ? null
              : "Choose files to move."
      }
      footerNote={`${selected.length} selected.`}
      busy={busy}
      error={
        error && (
          <FailureAlert
            size="compact"
            failure={error}
            onRetry={() => {
              setError(null);
              if (rows.length === 0) {
                setLoading(true);
                setAttempt((value) => value + 1);
              } else void quarantine();
            }}
          />
        )
      }
      onSubmit={() => void quarantine()}
    >
      <p className="attachment-hint">
        Local files move to reversible quarantine. They remain in complete
        backups and continue to occupy disk space until explicitly purged.
        Remote files are never deleted.
      </p>
      {loading ? (
        <p role="status">Reviewing files…</p>
      ) : (
        <>
          <p className="attachment-hint">
            {rows.filter((row) => row.eligible).length} eligible on this page ·{" "}
            {rows.filter((row) => !row.eligible).length} protected or
            unavailable
          </p>
          <ul
            className="attachment-cleanup-files"
            aria-label="Eligible local files"
          >
            {rows.filter((row) => row.eligible).map(fileRow)}
          </ul>
          {!rows.some((row) => row.eligible) && (
            <p>No eligible files on this page.</p>
          )}
          {rows.some((row) => !row.eligible) && (
            <Disclosure
              label="Protected or unavailable"
              count={rows.filter((row) => !row.eligible).length}
            >
              <ul
                className="attachment-cleanup-files"
                aria-label="Protected or unavailable files"
              >
                {rows.filter((row) => !row.eligible).map(fileRow)}
              </ul>
            </Disclosure>
          )}
          <div className="attachment-actions">
            <Button
              variant="ghost"
              disabled={busy || offset === 0}
              onClick={() => page(Math.max(0, offset - 50))}
            >
              Previous files
            </Button>
            <Button
              variant="ghost"
              disabled={busy || rows.length < 50}
              onClick={() => page(offset + 50)}
            >
              Next files
            </Button>
          </div>
        </>
      )}
    </DialogShell>
  );
}
