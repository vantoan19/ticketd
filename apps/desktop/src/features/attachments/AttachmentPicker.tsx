import { DrivePicker } from "./DrivePicker";
import { DriveSetupNotice } from "./DriveSetupNotice";
import { formatSize } from "./format-size";
import { useCallback, useEffect, useRef, useState } from "react";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FailureAlert } from "@/components/ui/failure-alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  attachments,
  type Attachment,
  type CaptureSource,
  type UploadProgress,
  type DriveUploadDestination,
  type DriveConfiguration,
  type AttachmentUploadDestination,
} from "@/lib/api/attachments";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import "@/features/tickets/ticket-attachments.css";
import { useNativeFileDrop } from "./use-native-file-drop";
import { UploadRecovery, type UploadRecord } from "./upload-recovery";
import { ExistingAttachments } from "./ExistingAttachments";

type UploadAttempt = UploadRecord & {
  state:
    "queued" | "uploading" | "attaching" | "inserted" | "failed" | "canceled";
  progress: UploadProgress;
  /** What happened to this upload, in plain words, when nothing failed. */
  note?: string;
  /** Why this upload failed; its Retry shows only when retrying can succeed. */
  failure?: FailureDescription;
};

/** A failure ticketd found itself, before anything was sent: no Details. */
function plainFailure(
  title: string,
  sentence: string,
  action: FailureDescription["action"] = null,
  code: FailureDescription["code"] = "failed",
): FailureDescription {
  return { code, title, sentence, action, details: "" };
}

/** A file over the workspace limit: the sizes, and the limit as the fix. */
function tooLarge(size: number | null, limit: number | null) {
  return plainFailure(
    "Too large",
    [
      size === null
        ? "The file is larger than the upload limit."
        : `The file is ${formatSize(size)}.`,
      limit === null ? "" : `The limit is ${formatSize(limit)}.`,
    ]
      .filter(Boolean)
      .join(" "),
    "change_limit",
    "too_large",
  );
}
function isCanceled(row: UploadAttempt) {
  return row.state === "canceled";
}

export function AttachmentPicker({
  open,
  onOpenChange,
  onPick,
  capture,
  ticketReference = null,
  purpose = "insert",
  single = false,
}: {
  open: boolean;
  ticketReference?: string | null | undefined;
  purpose?: "insert" | "store";
  onOpenChange: (open: boolean) => void;
  onPick: (
    file: Attachment,
    requestId: string,
    beforeId?: string,
  ) => Promise<void>;
  capture?: { sources: CaptureSource[] } | undefined;
  single?: boolean;
}) {
  const [tab, setTab] = useState<"upload" | "existing" | "drive">("upload");
  const [id, setId] = useState("");
  const [rows, setRows] = useState<UploadAttempt[]>([]);
  const attempts = useRef<UploadAttempt[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FailureDescription | null>(null);
  const [limit, setLimit] = useState<number | null>(null);
  const [workspaceDestination, setWorkspaceDestination] =
    useState<AttachmentUploadDestination | null>(null);
  const [explicitDestination, setExplicitDestination] =
    useState<AttachmentUploadDestination | null>(null);
  const destinationRead = useRef(0);
  const displayedDestination = explicitDestination ?? workspaceDestination;
  const destination: DriveUploadDestination | undefined =
    displayedDestination?.kind === "google_drive"
      ? displayedDestination.destination
      : undefined;
  const folderName =
    displayedDestination?.kind === "google_drive"
      ? displayedDestination.folder_name
      : "";
  const [folderConfiguration, setFolderConfiguration] =
    useState<DriveConfiguration | null>(null);
  const folderSelection = useRef<string | null>(null);
  const insertion = useRef(0);
  const reuseRequests = useRef(new Map<string, string>());
  const running = useRef(false);
  const pick = useRef(onPick);
  const dropTarget = useRef<HTMLDivElement>(null);
  const recovery = useRef<Promise<UploadRecovery | null> | null>(null);
  useEffect(() => {
    pick.current = onPick;
  }, [onPick]);
  function update() {
    setRows([...attempts.current]);
  }
  useEffect(
    () => () => {
      insertion.current += 1;
      if (folderSelection.current)
        void attachments
          .cancelDriveSelection(folderSelection.current)
          .catch(() => {});
    },
    [],
  );
  useEffect(
    () => () => {
      void recovery.current
        ?.then((journal) => journal?.close())
        .catch(() => {});
    },
    [],
  );
  const loadRecovery = useCallback(async () => {
    if (typeof indexedDB === "undefined")
      throw new Error("Local upload recovery storage is unavailable");
    recovery.current ??= UploadRecovery.open().then(async (journal) => {
      const records = await journal.list();
      attempts.current.push(
        ...records.map((record): UploadAttempt => ({
          ...record,
          state: "canceled",
          progress: { copied: 0, total: 0 },
          note: "Recovered upload. Retry to insert at the current caret.",
        })),
      );
      update();
      return journal;
    });
    return recovery.current;
  }, []);
  useEffect(() => {
    if (open)
      void loadRecovery().catch((reason: unknown) => {
        const failure = describeFailure(reason, "open upload recovery");
        setError({
          ...failure,
          sentence: `${failure.sentence} No new files are uploaded until it opens.`,
        });
      });
  }, [open, loadRecovery]);
  function changeOpen(next: boolean) {
    if (!next) {
      insertion.current += 1;
      setExplicitDestination(null);
      if (folderSelection.current)
        void attachments
          .cancelDriveSelection(folderSelection.current)
          .catch(() => {});
    }
    onOpenChange(next);
  }
  useEffect(() => {
    if (!open) return;
    let current = true;
    const readRevision = ++destinationRead.current;
    void attachments
      .uploadDestination()
      .then((value) => {
        if (current && readRevision === destinationRead.current)
          setWorkspaceDestination(value);
      })
      .catch((reason: unknown) => {
        if (current && readRevision === destinationRead.current)
          setError(describeFailure(reason, "read the upload destination"));
      });
    void attachments
      .uploadLimit()
      .then((value) => {
        if (current) setLimit(value);
      })
      .catch((reason: unknown) => {
        if (current) setError(describeFailure(reason, "read the upload limit"));
      });
    return () => {
      current = false;
    };
  }, [open]);

  async function run() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    const currentInsertion = insertion.current;
    try {
      for (const next of attempts.current) {
        if (next.state !== "queued") continue;
        // Closing abandons insertion, but never erases an already completed upload.
        delete next.note;
        delete next.failure;
        next.state = next.stored ? "attaching" : "uploading";
        update();
        try {
          const journal = await loadRecovery();
          await bindDestination(next);
          if (!next.stored && typeof next.source !== "string") {
            const bound = await attachments.uploadLimit();
            if (next.source.size > bound) {
              next.state = "failed";
              next.failure = tooLarge(next.source.size, bound);
              update();
              continue;
            }
          }
          // Persist the original identity and clipboard bytes before starting any effect.
          await journal?.put(next);
          if (isCanceled(next)) continue;
          next.stored = next.stored
            ? await attachments.inspect(next.stored.id)
            : await attachments.upload(
                next.source,
                next.requestId,
                (value) => {
                  next.progress = value;
                  update();
                },
                next.destination,
              );
          await journal?.put(next);
          if (
            next.stored.purge_state === "purged" ||
            next.stored.purge_state === "pending"
          )
            throw new Error(
              next.stored.purge_state === "purged"
                ? "Local bytes were permanently purged. Restore an older complete backup or choose a new upload; retry keeps this unavailable identity."
                : "Permanent purge is pending; local bytes are unavailable. Finish the explicit purge in Attachments or deliberately restore an older complete backup.",
            );
          if (isCanceled(next) || insertion.current !== currentInsertion) {
            next.state = "canceled";
            update();
            continue;
          }
          next.state = "attaching";
          update();
          const later = attempts.current
            .filter((row) => row.state === "inserted" && row.order > next.order)
            .sort((left, right) => left.order - right.order)[0];
          await pick.current(
            next.stored,
            next.linkRequestId,
            later?.stored?.id,
          );
          if (insertion.current !== currentInsertion) {
            next.state = "canceled";
            update();
            continue;
          }
          next.state = "inserted";
          await journal?.remove(next.requestId);
        } catch (reason) {
          if (next.state === "inserted") {
            const failure = describeFailure(
              reason,
              "clear the upload recovery entry",
            );
            setError({
              ...failure,
              sentence:
                "The file is attached. Reuse it from Existing files rather than uploading again.",
            });
          } else if (next.state !== "canceled") {
            next.state = "failed";
            next.failure = rowFailure(reason, next);
          }
        }
        update();
      }
    } finally {
      running.current = false;
      setBusy(false);
      if (
        attempts.current.length &&
        attempts.current.every((row) => row.state === "inserted") &&
        insertion.current === currentInsertion
      )
        changeOpen(false);
    }
  }
  async function enqueue(sources: CaptureSource[]) {
    if (!sources.length) return;
    const currentInsertion = insertion.current;
    if (single && sources.length > 1) {
      setError(
        plainFailure(
          "Choose one file",
          "Only one file can replace this reference. Nothing was uploaded.",
        ),
      );
      return;
    }
    let journal: UploadRecovery | null;
    let intent: AttachmentUploadDestination;
    try {
      journal = await loadRecovery();
      const readRevision = ++destinationRead.current;
      // Freeze one core preference snapshot for this selection, including files
      // queued behind a slow or temporarily failed destination binding.
      intent = explicitDestination ?? (await attachments.uploadDestination());
      if (insertion.current !== currentInsertion) return;
      if (!explicitDestination && readRevision === destinationRead.current)
        setWorkspaceDestination(intent);
    } catch (reason) {
      const failure = describeFailure(reason, "prepare the upload");
      setError({
        ...failure,
        sentence: `${failure.sentence} No uploads were started.`,
      });
      return;
    }
    const started =
      Math.max(0, ...attempts.current.map((attempt) => attempt.order)) + 1;
    let index = 0;
    const batch: UploadAttempt[] = sources.map((source) => ({
      source,
      name:
        typeof source === "string"
          ? (source.split(/[\\/]/).at(-1) ?? source)
          : source.name,
      order: started + index++ / 1000,
      requestId: crypto.randomUUID(),
      linkRequestId: crypto.randomUUID(),
      intent,
      state: "queued",
      progress: {
        copied: 0,
        total: typeof source === "string" ? 0 : source.size,
      },
    }));
    attempts.current.push(...batch);
    setTab("upload");
    update();
    // Reserve every selected operation before starting the first copy, including
    // files queued behind a slow upload when the application is interrupted.
    for (const row of batch) {
      try {
        // A failed destination bind must remain recoverable with this request ID.
        await journal?.put(row);
        await bindDestination(row);
        if (typeof row.source !== "string") {
          const bound = await attachments.uploadLimit();
          if (row.source.size > bound) {
            row.state = "failed";
            row.failure = tooLarge(row.source.size, bound);
            continue;
          }
        }
        await journal?.put(row);
      } catch (reason) {
        row.state = "failed";
        row.failure = rowFailure(reason, row);
      }
    }
    if (insertion.current !== currentInsertion) {
      for (const row of batch)
        if (row.state === "queued") row.state = "canceled";
      update();
      return;
    }
    update();
    void run();
  }
  function rowFailure(reason: unknown, row: UploadAttempt) {
    const failure = describeFailure(reason, "upload this file");
    if (failure.code !== "too_large") return failure;
    const size =
      typeof row.source === "string"
        ? row.progress.total || null
        : row.source.size;
    return { ...tooLarge(size, limit), details: failure.details };
  }
  async function bindDestination(row: UploadAttempt) {
    if (row.intent === undefined) return;
    const bound = await attachments.beginUpload(row.requestId, row.intent);
    if (bound.kind === "google_drive") {
      row.destination = bound.destination;
      row.destinationName = bound.folder_name;
    }
    delete row.intent;
  }
  const dropFailure = useNativeFileDrop(
    dropTarget,
    open && tab === "upload",
    (paths) => enqueue(paths),
  );
  const received = useRef<typeof capture>(undefined);
  useEffect(() => {
    if (open && capture && received.current !== capture) {
      received.current = capture;
      enqueue(capture.sources);
    }
  });
  async function choose() {
    const currentInsertion = insertion.current;
    setError(null);
    try {
      const sources = await attachments.chooseFile(!single);
      if (insertion.current === currentInsertion) enqueue(sources);
    } catch (reason) {
      setError(describeFailure(reason, "choose files"));
    }
  }
  async function chooseFolder() {
    const currentInsertion = insertion.current;
    setBusy(true);
    setError(null);
    try {
      const configuration = await attachments.driveConfiguration();
      if (insertion.current !== currentInsertion) return;
      setFolderConfiguration(configuration);
      if (!configuration.configured) return;
      const operationId = crypto.randomUUID();
      folderSelection.current = operationId;
      const selected = await attachments.chooseDriveFolder(operationId);
      if (insertion.current === currentInsertion) {
        setExplicitDestination({
          kind: "google_drive",
          destination: selected.destination,
          folder_name: selected.folder.name,
        });
      }
    } catch (reason) {
      setError(describeFailure(reason, "choose a Drive folder"));
    } finally {
      folderSelection.current = null;
      setBusy(false);
    }
  }
  function uploadLocally(row: UploadAttempt) {
    row.state = "canceled";
    row.note =
      "Local upload chosen explicitly. Any completed remote file remains in Drive; this Drive operation is retained for status checks.";
    const local: UploadAttempt = {
      source: row.source,
      name: row.name,
      order: row.order,
      requestId: crypto.randomUUID(),
      linkRequestId: crypto.randomUUID(),
      state: "queued",
      progress: { copied: 0, total: 0 },
    };
    attempts.current.push(local);
    update();
    void run();
  }
  async function reuse(attachmentId: string) {
    setBusy(true);
    setError(null);
    try {
      const currentInsertion = insertion.current;
      const file = await attachments.inspect(attachmentId.trim());
      if (insertion.current !== currentInsertion) return;
      const requestId =
        reuseRequests.current.get(file.id) ?? crypto.randomUUID();
      reuseRequests.current.set(file.id, requestId);
      await onPick(file, requestId);
      reuseRequests.current.delete(file.id);
      if (insertion.current === currentInsertion) changeOpen(false);
    } catch (reason) {
      setError(describeFailure(reason, "reuse the file"));
    } finally {
      setBusy(false);
    }
  }
  const existingInsertion = insertion.current;
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent
        ref={dropTarget}
        className={
          tab === "existing"
            ? // Existing files stays inside the window and only its list
              // scrolls, so Insert selected is always in view.
              "sm:max-w-170 flex max-h-dvh flex-col overflow-hidden"
            : "sm:max-w-170 max-h-dvh overflow-y-auto"
        }
      >
        <DialogHeader>
          <DialogTitle>
            {purpose === "store" ? "Add files" : "Attach file"}
          </DialogTitle>
          <DialogDescription>
            {purpose === "store"
              ? "Store files in this workspace for reuse across tickets and Documents."
              : "Upload, reuse a workspace file, or select a Google Drive reference."}
          </DialogDescription>
        </DialogHeader>
        {purpose === "insert" && (
          <SegmentedControl
            aria-label="Attachment source"
            value={tab}
            onValueChange={setTab}
            options={[
              { value: "upload", label: "Upload", disabled: busy },
              { value: "existing", label: "Existing files", disabled: busy },
              { value: "drive", label: "Google Drive", disabled: busy },
            ]}
          />
        )}
        {tab === "upload" || purpose === "store" ? (
          <>
            <div
              className="attachment-upload"
              onDragOver={(event) => {
                if (event.dataTransfer.types.includes("Files"))
                  event.preventDefault();
              }}
              onDrop={(event) => {
                if (!event.dataTransfer.files.length) return;
                event.preventDefault();
                event.stopPropagation();
                enqueue(Array.from(event.dataTransfer.files));
              }}
            >
              <Upload aria-hidden="true" />
              <p>Drop files here or choose from your computer</p>
              <p className="attachment-hint">
                Any file type ·{" "}
                {limit === null
                  ? "Reading workspace limit…"
                  : `Up to ${formatSize(limit)} per file`}
              </p>
              <Button disabled={busy} onClick={() => void choose()}>
                {single ? "Choose file" : "Choose files"}
              </Button>
              <small>
                {!displayedDestination
                  ? "Reading upload destination…"
                  : destination
                    ? `Destination: Google Drive · ${folderName}`
                    : "Destination: Local workspace"}
              </small>
              <div className="attachment-actions">
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void chooseFolder()}
                >
                  Choose Drive folder
                </Button>
                {destination && (
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setExplicitDestination({ kind: "local" });
                    }}
                  >
                    Use local for new uploads
                  </Button>
                )}
              </div>
            </div>
            {folderConfiguration && (
              <DriveSetupNotice configuration={folderConfiguration} />
            )}
            {rows.length > 0 && (
              <ul className="attachment-uploads" aria-label="Uploads">
                {rows.map((row) => (
                  <li key={row.requestId} aria-label={row.name}>
                    <div>
                      <strong>{row.name}</strong>
                      <small className="attachment-hint">
                        {row.stored
                          ? formatSize(row.stored.size_bytes)
                          : row.progress.total
                            ? `${formatSize(row.progress.copied)} / ${formatSize(row.progress.total)}`
                            : "Size pending"}
                      </small>
                      <p role="status">
                        {row.state === "inserted"
                          ? purpose === "store"
                            ? "Stored"
                            : "Attached"
                          : row.state === "canceled"
                            ? "Canceled"
                            : row.state === "failed"
                              ? "Needs retry"
                              : row.state === "queued"
                                ? "Queued"
                                : row.state === "attaching"
                                  ? "Attaching file…"
                                  : "Storing file…"}
                      </p>
                      {(row.state === "uploading" ||
                        row.state === "attaching") && (
                        <progress
                          aria-label={`Upload ${row.name}`}
                          value={row.progress.copied}
                          max={row.progress.total || 1}
                        />
                      )}
                      {row.note && (
                        <p className="attachment-hint">{row.note}</p>
                      )}
                      {row.failure && (
                        <FailureAlert size="compact" failure={row.failure} />
                      )}
                      {row.stored && row.state !== "inserted" && (
                        <p className="attachment-hint">
                          Stored as {row.stored.id}.{" "}
                          {row.stored.purge_state === "purged" ||
                          row.stored.purge_state === "pending"
                            ? "Local bytes are unavailable. Its identity remains in Existing files for inspection."
                            : row.destination
                              ? "Any completed file remains in Drive. Retry checks whether its ticketd record is still registered."
                              : "Retry checks current availability before reuse. Inspect its identity in Existing files."}
                        </p>
                      )}
                      {row.destination && (
                        <p className="attachment-hint">
                          Google Drive ·{" "}
                          {row.destinationName || "Selected upload folder"} ·
                          Uploaded copy · Original bytes are not guaranteed. Any
                          completed file remains in Drive.
                        </p>
                      )}
                    </div>
                    <div className="attachment-actions">
                      {(row.state === "failed" || row.state === "canceled") && (
                        <>
                          {row.destination && !row.stored && (
                            <>
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={busy}
                                onClick={() => {
                                  setBusy(true);
                                  void attachments
                                    .checkDriveUpload(row.requestId)
                                    .then(async (result) => {
                                      if (result.attachment) {
                                        row.stored = result.attachment;
                                        await (await loadRecovery())?.put(row);
                                        delete row.failure;
                                        row.note =
                                          "Upload complete. Retry to insert the existing uploaded copy.";
                                      } else
                                        row.note =
                                          "Not confirmed complete. Retry reconciles the same remote ID before sending bytes.";
                                      update();
                                    })
                                    .catch((reason: unknown) => {
                                      row.failure = describeFailure(
                                        reason,
                                        "check the upload",
                                      );
                                      update();
                                    })
                                    .finally(() => setBusy(false));
                                }}
                              >
                                Check status
                              </Button>
                              <Button
                                disabled={busy}
                                variant="ghost"
                                onClick={() => uploadLocally(row)}
                              >
                                Upload locally instead
                              </Button>
                            </>
                          )}
                          {row.destination && (
                            <Button
                              variant="ghost"
                              onClick={() =>
                                void attachments
                                  .openDriveUpload(row.requestId)
                                  .catch((reason: unknown) =>
                                    setError(
                                      describeFailure(
                                        reason,
                                        "open the file in Drive",
                                      ),
                                    ),
                                  )
                              }
                            >
                              Open in Drive
                            </Button>
                          )}
                          {(row.state === "canceled" ||
                            !row.failure ||
                            row.failure.action === "retry") && (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busy}
                              onClick={() => {
                                row.state = "queued";
                                update();
                                void run();
                              }}
                            >
                              Retry
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            disabled={busy}
                            onClick={() => {
                              void loadRecovery()
                                .then(async (journal) => {
                                  await journal?.remove(row.requestId);
                                  attempts.current = attempts.current.filter(
                                    (other) => other !== row,
                                  );
                                  update();
                                })
                                .catch((reason: unknown) =>
                                  setError(
                                    describeFailure(
                                      reason,
                                      "dismiss the upload",
                                    ),
                                  ),
                                );
                            }}
                          >
                            Dismiss
                          </Button>
                        </>
                      )}
                      {(["queued", "uploading"] as string[]).includes(
                        row.state,
                      ) && (
                        <Button
                          variant="ghost"
                          onClick={() => {
                            row.state = "canceled";
                            update();
                            void attachments
                              .cancel(row.requestId)
                              .catch((reason: unknown) => {
                                const failure = describeFailure(
                                  reason,
                                  "confirm the cancellation",
                                );
                                row.failure = {
                                  ...failure,
                                  action: null,
                                  sentence: `${failure.sentence} Any completed file stays available.`,
                                };
                                update();
                              });
                          }}
                        >
                          Cancel
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <p className="attachment-hint">
              {purpose === "store"
                ? "Stored files remain available for reuse. Choose them in a ticket or Document to create a reference."
                : "Completed files remain available if insertion is canceled or saving fails. Retry keeps the original upload identity."}
            </p>
          </>
        ) : tab === "drive" ? (
          open && (
            <DrivePicker
              single={single}
              onComplete={() => changeOpen(false)}
              onPick={onPick}
            />
          )
        ) : (
          <div className="attachment-existing">
            <Label htmlFor="reuse-attachment-id">Attachment ID</Label>
            <div className="attachment-actions">
              <Input
                id="reuse-attachment-id"
                value={id}
                onChange={(event) => setId(event.target.value)}
              />
              <Button
                disabled={busy || !id.trim()}
                onClick={() => void reuse(id)}
              >
                Reuse ID
              </Button>
            </div>
            <ExistingAttachments
              single={single}
              ticketReference={ticketReference}
              onBusyChange={setBusy}
              onDone={() => {
                if (insertion.current === existingInsertion) changeOpen(false);
              }}
              onPick={async (file, requestId) => {
                if (insertion.current !== existingInsertion)
                  throw new Error(
                    "Insertion was canceled. The file remains in the workspace.",
                  );
                const stored = await attachments.inspect(file.id);
                if (insertion.current !== existingInsertion)
                  throw new Error(
                    "Insertion was canceled. The file remains in the workspace.",
                  );
                await pick.current(stored, requestId);
              }}
            />
          </div>
        )}
        {error && <FailureAlert size="compact" failure={error} />}
        {dropFailure && (
          <p role="alert" className="attachment-hint">
            {dropFailure}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
