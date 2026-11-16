import { useDialogPresence } from "@/components/ui/use-dialog-presence";
import { useEffect, useState } from "react";
import { Disclosure } from "@/components/ui/disclosure";
import { DialogShell } from "@/components/ui/dialog-shell";
import { EmptyState } from "@/components/ui/empty-state";
import { FailureAlert, FailureState } from "@/components/ui/failure-alert";
import { Pager } from "@/components/ui/pager";
import { Skeleton } from "@/components/ui/skeleton";
import {
  attachments,
  type Attachment,
  type AttachmentCleanupReview,
} from "@/lib/api/attachments";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { AttachmentThumbnail } from "./AttachmentThumbnail";
import { fileType, purged } from "./file-words";
import { formatSize } from "./format-size";
import { usageContext } from "./usage-context";

const PAGE = 50;

/**
 * Clean up unused files (shell AT-14, set EM-10): one DialogShell md listing
 * the unused files with their checkboxes on the left and Select all; the
 * files something still uses fold under "Protected", each with its reason.
 * The note counts the choice and its size; the primary keeps one label.
 * Moving them is reversible: the library offers Undo in its status line.
 */
export function AttachmentCleanup({
  onClose,
  onChanged,
  onMoved,
}: {
  onClose: () => void;
  onChanged: () => void;
  /** The files moved to quarantine, for the library's "Moved … · Undo". */
  onMoved?: (files: Attachment[]) => void;
}) {
  const presence = useDialogPresence(onClose);
  const [rows, setRows] = useState<AttachmentCleanupReview[]>([]);
  const [offset, setOffset] = useState(0);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FailureDescription | null>(null);
  const [loadError, setLoadError] = useState<FailureDescription | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [selected, setSelected] = useState<
    { id: string; requestId: string; file: Attachment }[]
  >([]);
  useEffect(() => {
    let current = true;
    void attachments
      .cleanupReviews(offset)
      .then((next) => {
        if (!current) return;
        setRows((previous) => (offset === 0 ? next : [...previous, ...next]));
        setMore(next.length >= PAGE);
        setLoadError(null);
        setLoading(false);
      })
      .catch((reason: unknown) => {
        if (!current) return;
        setLoadError(describeFailure(reason, "review unused files"));
        setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [offset, attempt]);
  // Only the first read hides the list; "Show 50 more" keeps it in place.
  const reviewing = loading && rows.length === 0;
  const eligible = rows.filter((row) => row.eligible);
  const kept = rows.filter((row) => !row.eligible);
  async function quarantine() {
    setBusy(true);
    setError(null);
    const moved: Attachment[] = [];
    try {
      for (const item of selected) {
        await attachments.quarantine(item.id, item.requestId);
        moved.push(item.file);
        setSelected((previous) => previous.filter((row) => row.id !== item.id));
      }
      presence.close();
    } catch (reason) {
      const failure = describeFailure(reason, "move the remaining files");
      setError({
        ...failure,
        sentence: `${moved.length ? `${moved.length} moved to quarantine. ` : ""}${failure.sentence} The rest stay where they are.`,
      });
    } finally {
      setBusy(false);
      onChanged();
      if (moved.length) onMoved?.(moved);
    }
  }
  function toggle(row: AttachmentCleanupReview, checked: boolean) {
    setSelected((previous) =>
      checked
        ? [
            ...previous,
            {
              id: row.attachment.id,
              requestId: crypto.randomUUID(),
              file: row.attachment,
            },
          ]
        : previous.filter((item) => item.id !== row.attachment.id),
    );
  }
  const bytes = selected.reduce(
    (sum, item) => sum + (item.file.size_bytes ?? 0),
    0,
  );
  const allChosen =
    eligible.length > 0 &&
    eligible.every((row) =>
      selected.some((item) => item.id === row.attachment.id),
    );
  function fileRow(row: AttachmentCleanupReview) {
    const file = row.attachment;
    return (
      <li key={file.id}>
        <label>
          <input
            type="checkbox"
            aria-label={`Select ${file.display_name}`}
            disabled={busy || !row.eligible}
            checked={selected.some((item) => item.id === file.id)}
            onChange={(event) => toggle(row, event.target.checked)}
          />
          <AttachmentThumbnail file={file} size="row" />
          <span>
            {file.display_name}
            <small>
              {[
                fileType(file.original_filename).word,
                file.size_bytes != null && formatSize(file.size_bytes),
                file.kind === "external_reference" && "Google Drive",
              ]
                .filter(Boolean)
                .join(" · ")}
            </small>
          </span>
        </label>
        {!row.eligible && (
          <p className="attachment-cleanup-reason">
            {purged(file) || !row.usage.protections.length
              ? row.reason
              : usageContext(row.usage)}
          </p>
        )}
      </li>
    );
  }
  const empty = !reviewing && !loadError && eligible.length === 0;
  return (
    <DialogShell
      {...presence.dialog}
      title="Clean up unused files"
      description="Move unused files to quarantine. You can restore them until you delete them permanently."
      primaryLabel={empty || loadError ? null : "Move to quarantine"}
      cancelLabel={empty || loadError ? "Close" : "Cancel"}
      blockedReason={
        busy
          ? "Moving files…"
          : reviewing
            ? "Reviewing files…"
            : selected.length
              ? null
              : "Choose files to move."
      }
      footerNote={`${selected.length} selected · ${formatSize(bytes)}`}
      busy={busy}
      error={
        error && (
          <FailureAlert
            size="compact"
            failure={error}
            onRetry={() => void quarantine()}
          />
        )
      }
      onSubmit={() => void quarantine()}
    >
      {loadError ? (
        <FailureState
          failure={loadError}
          onRetry={() => {
            setLoading(true);
            setAttempt((value) => value + 1);
          }}
        />
      ) : reviewing ? (
        <div role="status" aria-label="Reviewing files" className="grid gap-3">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-2/3" />
        </div>
      ) : (
        <>
          {empty ? (
            <EmptyState
              size="inline"
              plain
              title="No unused files."
              description="Files no ticket or Document uses show up here."
            />
          ) : (
            <>
              <label className="attachment-cleanup-all">
                <input
                  type="checkbox"
                  aria-label="Select all unused files"
                  disabled={busy}
                  checked={allChosen}
                  onChange={(event) =>
                    setSelected(
                      event.target.checked
                        ? eligible.map((row) => ({
                            id: row.attachment.id,
                            requestId:
                              selected.find(
                                (item) => item.id === row.attachment.id,
                              )?.requestId ?? crypto.randomUUID(),
                            file: row.attachment,
                          }))
                        : [],
                    )
                  }
                />
                Select all
              </label>
              <ul
                className="attachment-cleanup-files"
                aria-label="Unused files"
              >
                {eligible.map(fileRow)}
              </ul>
            </>
          )}
          {kept.length > 0 && (
            <Disclosure label="Protected" count={kept.length}>
              <ul
                className="attachment-cleanup-files"
                aria-label="Protected files"
              >
                {kept.map(fileRow)}
              </ul>
            </Disclosure>
          )}
          {more && (
            <Pager
              more={PAGE}
              noun="files"
              loading={loading}
              onMore={() => {
                setLoading(true);
                setOffset((value) => value + PAGE);
              }}
            />
          )}
        </>
      )}
    </DialogShell>
  );
}
