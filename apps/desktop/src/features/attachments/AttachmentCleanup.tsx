import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  attachments,
  type AttachmentCleanupReview,
} from "@/lib/api/attachments";
import { formatSize } from "./format-size";

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
  const [error, setError] = useState("");
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
          setError(String(reason));
          setLoading(false);
        }
      });
    return () => {
      current = false;
    };
  }, [offset]);
  async function quarantine() {
    setBusy(true);
    setError("");
    let completed = 0;
    try {
      for (const item of selected) {
        await attachments.quarantine(item.id, item.requestId);
        completed += 1;
        setSelected((previous) => previous.filter((row) => row.id !== item.id));
      }
      onClose();
    } catch (reason) {
      setError(
        `${completed ? `${completed} moved to quarantine. ` : ""}${String(reason)}. Remaining files were not confirmed; retry or review them again.`,
      );
    } finally {
      setBusy(false);
      onChanged();
    }
  }
  function page(next: number) {
    setSelected([]);
    setRows([]);
    setLoading(true);
    setError("");
    setOffset(next);
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        className="attachment-cleanup-dialog"
        showCloseButton={!busy}
      >
        <DialogHeader>
          <DialogTitle>Review unused attachments</DialogTitle>
          <DialogDescription>
            Choose files to move out of your active workspace. Eligibility is
            checked again before cleanup.
          </DialogDescription>
        </DialogHeader>
        <p className="attachment-hint">
          Local files move to reversible quarantine. They remain in complete
          backups and continue to occupy disk space until explicitly purged.
          Remote files are never deleted.
        </p>
        {error && <p role="alert">{error}</p>}
        {loading ? (
          <p role="status">Reviewing files…</p>
        ) : (
          <>
            <p className="attachment-hint">
              {rows.filter((row) => row.eligible).length} eligible on this page
              · {rows.filter((row) => !row.eligible).length} protected or
              unavailable
            </p>
            <ul className="attachment-cleanup-files">
              {rows.map((row) => (
                <li key={row.attachment.id}>
                  <label>
                    <input
                      type="checkbox"
                      aria-label={`Select ${row.attachment.display_name}`}
                      disabled={busy || !row.eligible}
                      checked={selected.some(
                        (item) => item.id === row.attachment.id,
                      )}
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
                            previous.filter(
                              (item) => item.id !== row.attachment.id,
                            ),
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
                  <p>{row.reason}</p>
                  {row.usage.protections.length > 0 && (
                    <details>
                      <summary>
                        Protected references ({row.usage.protections.length})
                      </summary>
                      <ul>
                        {row.usage.protections.map((use) => (
                          <li key={`${use.kind}:${use.owner}`}>
                            {use.kind === "draft"
                              ? "Recoverable draft"
                              : use.kind === "undo"
                                ? "Retained for Undo"
                                : use.kind.replaceAll("_", " ")}
                            {use.trashed ? " · Trash" : ""} · {use.owner}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </li>
              ))}
            </ul>
            {!rows.length && <p>No files to review.</p>}
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
        <div className="attachment-actions attachment-cleanup-footer">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy || loading || !selected.length}
            onClick={() => void quarantine()}
          >
            {busy ? "Moving files…" : "Move to quarantine"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
