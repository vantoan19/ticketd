import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DialogShell } from "@/components/ui/dialog-shell";
import { FailureAlert, FailureDetails } from "@/components/ui/failure-alert";
import { Progress } from "@/components/ui/progress";
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
import { SettingsNavigation } from "@/lib/settings-navigation";
import "./attachment-picker.css";
import { DrivePicker } from "./DrivePicker";
import { addDriveFiles, type DriveChoice } from "./drive-choices";
import { DriveSetupNotice } from "./DriveSetupNotice";
import {
  ExistingAttachments,
  type ExistingChoice,
} from "./ExistingAttachments";
import { FileIcon } from "./AttachmentThumbnail";
import { fileType } from "./file-words";
import { formatSize } from "./format-size";
import { useNativeFileDrop } from "./use-native-file-drop";
import { UploadRecovery, type UploadRecord } from "./upload-recovery";

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

/**
 * A file over the workspace limit, said as the row reads it: "Too large:
 * 101 MB. The limit is 100 MB." The fix is the limit, never Retry (P8).
 */
function tooLarge(size: number | null, limit: number | null) {
  return plainFailure(
    size === null ? "Too large" : `Too large: ${formatSize(size)}`,
    limit === null
      ? "It is over the upload limit."
      : `The limit is ${formatSize(limit)}.`,
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
  replacing,
}: {
  open: boolean;
  ticketReference?: string | null | undefined;
  purpose?: "insert" | "store";
  /** The name of the file a replacement swaps out: titles "Replace notes.txt". */
  replacing?: string | undefined;
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
  const [existing, setExisting] = useState<ExistingChoice[]>([]);
  const [driveFiles, setDriveFiles] = useState<DriveChoice[]>([]);
  const [over, setOver] = useState(false);
  const openSettingsPage = useContext(SettingsNavigation);
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
          note: "Not finished last time. Retry to add it.",
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
      setExisting([]);
      setDriveFiles([]);
      setOver(false);
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
                ? "This file was deleted permanently. Choose it again from your computer."
                : "This file is being deleted permanently. Choose it again from your computer.",
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
                "The file is attached. Reuse it from Existing files instead of uploading it again.",
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
    open && (tab === "upload" || purpose === "store"),
    (paths) => enqueue(paths),
    setOver,
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
      "Uploading to this computer instead. Anything already in Drive stays there.";
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
  /** Settings, from inside the dialog: close it first, then open the page. */
  const openSettings = openSettingsPage
    ? (page: "attachments" | "google-drive") => () => {
        changeOpen(false);
        openSettingsPage(page);
      }
    : undefined;
  async function insertExisting() {
    if (single && existing.length !== 1) {
      setError(
        plainFailure(
          "Choose one file",
          "Only one file can replace this reference.",
        ),
      );
      return;
    }
    const session = insertion.current;
    const canceled = () =>
      new Error("Insertion was canceled. The file remains in the workspace.");
    setBusy(true);
    setError(null);
    try {
      for (const item of existing) {
        if (insertion.current !== session) throw canceled();
        const stored = await attachments.inspect(item.file.id);
        if (insertion.current !== session) throw canceled();
        await pick.current(stored, item.requestId);
        setExisting((rows) =>
          rows.filter((row) => row.file.id !== item.file.id),
        );
      }
      if (insertion.current === session) changeOpen(false);
    } catch (reason) {
      if (insertion.current === session)
        setError(
          describeFailure(
            reason,
            existing.length === 1 ? "insert the file" : "insert the files",
          ),
        );
    } finally {
      setBusy(false);
    }
  }
  async function addDrive() {
    const chosen = driveFiles.filter((item) => item.selected);
    if (single && chosen.length !== 1) {
      setError(
        plainFailure(
          "Choose one file",
          "Only one file can replace this reference.",
        ),
      );
      return;
    }
    const session = insertion.current;
    const live = () => insertion.current === session;
    setBusy(true);
    setError(null);
    try {
      const { left, failure } = await addDriveFiles(
        driveFiles,
        (file, requestId, beforeId) =>
          beforeId === undefined
            ? pick.current(file, requestId)
            : pick.current(file, requestId, beforeId),
        live,
      );
      if (!live()) return;
      setDriveFiles(left);
      if (failure) setError(failure);
      else changeOpen(false);
    } finally {
      setBusy(false);
    }
  }
  function removeRow(row: UploadAttempt) {
    void loadRecovery()
      .then(async (journal) => {
        await journal?.remove(row.requestId);
        attempts.current = attempts.current.filter((other) => other !== row);
        update();
      })
      .catch((reason: unknown) =>
        setError(describeFailure(reason, "remove the upload")),
      );
  }
  function checkDrive(row: UploadAttempt) {
    setBusy(true);
    void attachments
      .checkDriveUpload(row.requestId)
      .then(async (result) => {
        if (result.attachment) {
          row.stored = result.attachment;
          await (await loadRecovery())?.put(row);
          delete row.failure;
          row.note = "The upload finished. Retry to add it.";
        } else
          row.note =
            "Not confirmed yet. Retry checks Drive again before sending anything.";
        update();
      })
      .catch((reason: unknown) => {
        row.failure = describeFailure(reason, "check the upload");
        update();
      })
      .finally(() => setBusy(false));
  }
  const store = purpose === "store";
  const title = store
    ? "Add files"
    : replacing
      ? `Replace ${replacing}`
      : ticketReference
        ? `Attach to ${ticketReference}`
        : "Attach file";
  const description = store
    ? "Files you add stay in this workspace, ready for any ticket or Document."
    : replacing
      ? "Only this reference changes. Other places keep the original file."
      : undefined;
  const shownTab = store ? "upload" : tab;
  const added = rows.filter((row) => row.state === "inserted").length;
  const attention = rows.filter(
    (row) => row.state === "failed" || row.state === "canceled",
  ).length;
  const working = rows.length - added - attention;
  const uploadNote = [
    added && `${added} ${store ? "added" : "attached"}`,
    working && `${working} uploading`,
    attention && `${attention} not added`,
  ]
    .filter(Boolean)
    .join(" · ");
  const chosenDrive = driveFiles.filter((item) => item.selected).length;
  const footer =
    shownTab === "upload"
      ? {
          primaryLabel: single ? "Choose file" : "Choose files",
          blockedReason: null,
          footerNote: uploadNote || null,
          onSubmit: () => void choose(),
        }
      : shownTab === "existing"
        ? {
            primaryLabel: "Insert selected",
            blockedReason: busy
              ? "Inserting…"
              : existing.length
                ? null
                : single
                  ? "Choose the file to use instead."
                  : "Choose files to insert.",
            footerNote: `${existing.length} selected · No copy is made.`,
            onSubmit: () => void insertExisting(),
          }
        : {
            primaryLabel: "Add selected",
            blockedReason: busy
              ? "Adding…"
              : chosenDrive
                ? null
                : "Choose files in Google Drive first.",
            footerNote: `${chosenDrive} selected`,
            onSubmit: () => void addDrive(),
          };
  const shownError =
    error &&
    (shownTab === "existing" && existing.length ? (
      <FailureAlert
        size="compact"
        failure={error}
        onRetry={() => void insertExisting()}
      />
    ) : (
      <FailureAlert size="compact" failure={error} />
    ));
  return (
    <DialogShell
      open={open}
      onOpenChange={changeOpen}
      title={title}
      {...(description && { description })}
      primaryLabel={footer.primaryLabel}
      blockedReason={footer.blockedReason}
      footerNote={footer.footerNote}
      onSubmit={footer.onSubmit}
      initialFocus={shownTab === "existing" ? "first" : "primary"}
      error={shownError || null}
      {...(!store && {
        tabs: (
          <SegmentedControl
            aria-label="Attachment source"
            className="w-full"
            value={tab}
            onValueChange={(next) => {
              setError(null);
              setTab(next);
            }}
            options={[
              { value: "upload", label: "Upload", disabled: busy },
              { value: "existing", label: "Existing files", disabled: busy },
              { value: "drive", label: "Google Drive", disabled: busy },
            ]}
          />
        ),
      })}
    >
      <div className="attachment-picker" ref={dropTarget}>
        {shownTab === "upload" ? (
          <div className="attachment-picker-upload">
            <div
              className="attachment-dropzone"
              data-over={over || undefined}
              data-compact={rows.length > 0 || undefined}
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes("Files")) return;
                event.preventDefault();
                setOver(true);
              }}
              onDragLeave={() => setOver(false)}
              onDrop={(event) => {
                setOver(false);
                if (!event.dataTransfer.files.length) return;
                event.preventDefault();
                event.stopPropagation();
                enqueue(Array.from(event.dataTransfer.files));
              }}
            >
              <Upload aria-hidden="true" />
              <p>
                {over
                  ? "Drop to upload"
                  : single
                    ? "Drop a file here, or choose it from your computer."
                    : "Drop files here, or choose them from your computer."}
              </p>
              <p className="attachment-hint">
                {limit === null
                  ? "Any file type"
                  : `Any file type · Up to ${formatSize(limit)} each`}
              </p>
            </div>
            <div className="attachment-destination">
              <span className="attachment-hint">
                {!displayedDestination
                  ? "Reading where uploads go…"
                  : destination
                    ? `Uploads go to Google Drive · ${folderName}`
                    : "Uploads stay on this computer"}
              </span>
              <Button
                type="button"
                variant="link"
                size="inline"
                disabled={busy}
                onClick={() => void chooseFolder()}
              >
                Choose Drive folder
              </Button>
              {destination && (
                <Button
                  type="button"
                  variant="link"
                  size="inline"
                  disabled={busy}
                  onClick={() => setExplicitDestination({ kind: "local" })}
                >
                  Use this computer
                </Button>
              )}
            </div>
            {folderConfiguration && (
              <DriveSetupNotice
                configuration={folderConfiguration}
                onOpenSettings={openSettings?.("google-drive")}
              />
            )}
            {dropFailure && (
              <p role="alert" className="attachment-hint">
                {dropFailure}
              </p>
            )}
            {rows.length > 0 && (
              <ul className="attachment-queue" aria-label="Uploads">
                {rows.map((row) => (
                  <UploadRow
                    key={row.requestId}
                    row={row}
                    store={store}
                    busy={busy}
                    onRetry={() => {
                      row.state = "queued";
                      update();
                      void run();
                    }}
                    onRemove={() => removeRow(row)}
                    onCancel={() => {
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
                            sentence: `${failure.sentence} Any finished file stays available.`,
                          };
                          update();
                        });
                    }}
                    onCheckDrive={() => checkDrive(row)}
                    onUploadLocally={() => uploadLocally(row)}
                    onOpenDrive={() =>
                      void attachments
                        .openDriveUpload(row.requestId)
                        .catch((reason: unknown) =>
                          setError(
                            describeFailure(reason, "open the file in Drive"),
                          ),
                        )
                    }
                    onChangeLimit={openSettings?.("attachments")}
                  />
                ))}
              </ul>
            )}
          </div>
        ) : shownTab === "drive" ? (
          open && (
            <DrivePicker
              files={driveFiles}
              onFilesChange={setDriveFiles}
              busy={busy}
              onBusyChange={setBusy}
              onFailure={setError}
              onOpenSettings={openSettings?.("google-drive")}
            />
          )
        ) : (
          <ExistingAttachments
            single={single}
            ticketReference={ticketReference}
            selected={existing}
            onSelectedChange={(next) => {
              setError(null);
              setExisting(next);
            }}
            busy={busy}
          />
        )}
      </div>
    </DialogShell>
  );
}

/**
 * One file in the upload queue: its glyph and name, one caption with its
 * state ("31 KB of 2 MB", "Attached", "Too large: 101 MB. The limit is
 * 100 MB."), and only the actions that can help, never a primary.
 */
function UploadRow({
  row,
  store,
  busy,
  onRetry,
  onRemove,
  onCancel,
  onCheckDrive,
  onUploadLocally,
  onOpenDrive,
  onChangeLimit,
}: {
  row: UploadAttempt;
  store: boolean;
  busy: boolean;
  onRetry: () => void;
  onRemove: () => void;
  onCancel: () => void;
  onCheckDrive: () => void;
  onUploadLocally: () => void;
  onOpenDrive: () => void;
  onChangeLimit: (() => void) | undefined;
}) {
  const stopped = row.state === "failed" || row.state === "canceled";
  const total = row.stored?.size_bytes ?? (row.progress.total || null);
  const status =
    row.state === "inserted"
      ? store
        ? "Added"
        : "Attached"
      : row.state === "canceled"
        ? "Canceled"
        : row.state === "failed"
          ? null
          : row.state === "queued"
            ? "Waiting…"
            : row.state === "attaching"
              ? "Attaching…"
              : row.progress.total
                ? `${formatSize(row.progress.copied)} of ${formatSize(row.progress.total)}`
                : "Uploading…";
  const failure = row.state === "failed" ? row.failure : undefined;
  return (
    <li aria-label={row.name} className="attachment-upload-row">
      <FileIcon
        family={fileType(row.name).family}
        className="attachment-upload-glyph"
      />
      <div className="attachment-upload-text">
        <span className="attachment-upload-name">{row.name}</span>
        {failure ? (
          <p role="alert" className="attachment-upload-failure">
            {failure.title}. {failure.sentence}
          </p>
        ) : (
          <p role="status" className="attachment-hint">
            {[
              status,
              total !== null && row.state === "inserted" && formatSize(total),
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        )}
        {(row.state === "uploading" || row.state === "attaching") && (
          <Progress
            aria-label={`Upload ${row.name}`}
            value={
              row.progress.total
                ? Math.round((row.progress.copied / row.progress.total) * 100)
                : 0
            }
          />
        )}
        {row.note && <p className="attachment-hint">{row.note}</p>}
        {row.destination && stopped && (
          <p className="attachment-hint">
            Google Drive · {row.destinationName || "the chosen folder"}.
            Anything already uploaded stays in Drive.
          </p>
        )}
        {failure?.details && <FailureDetails small details={failure.details} />}
      </div>
      <div className="attachment-upload-actions">
        {stopped && (
          <>
            {failure?.action === "change_limit" && onChangeLimit && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onChangeLimit}
              >
                Change limit
              </Button>
            )}
            {row.destination && !row.stored && (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={onCheckDrive}
                >
                  Check status
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={onUploadLocally}
                >
                  Upload locally instead
                </Button>
              </>
            )}
            {row.destination && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onOpenDrive}
              >
                Open in Drive
              </Button>
            )}
            {(row.state === "canceled" ||
              !row.failure ||
              row.failure.action === "retry") && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={onRetry}
              >
                Retry
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={onRemove}
            >
              Remove
            </Button>
          </>
        )}
        {(row.state === "queued" || row.state === "uploading") && (
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </li>
  );
}
