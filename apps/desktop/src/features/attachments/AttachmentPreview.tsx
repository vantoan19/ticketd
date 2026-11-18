import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ArrowLeft, Download, Ellipsis, Link, X } from "lucide-react";
import {
  Alert,
  AlertActions,
  AlertTitle,
  AlertDescription,
} from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useDialogPresence } from "@/components/ui/use-dialog-presence";
import { CopyButton } from "@/components/ui/copy-button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { FailureAlert, FailureState } from "@/components/ui/failure-alert";
import { PaneHeader } from "@/components/ui/list-header";
import {
  ariaKeyShortcuts,
  matchesShortcut,
  shortcutLabel,
} from "@/lib/shortcuts";
import { IconButton } from "@/components/ui/icon-button";
import { RecordLink } from "@/components/ui/record-link";
import { Skeleton } from "@/components/ui/skeleton";
import { Time } from "@/components/ui/time";
import { Tooltip } from "@/components/ui/tooltip";
import {
  attachments,
  type Attachment,
  type PreviewInfo,
  type DriveCopyInspection,
} from "@/lib/api/attachments";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { SettingsNavigation } from "@/lib/settings-navigation";
import { DocumentNavigation } from "@/features/documents/navigation";
import { TicketNavigation } from "@/features/tickets/navigation";
import {
  storageWord,
  useAvailability,
} from "@/features/sync-review/availability";
import { isLinuxPlatform } from "@/lib/platform";
import { syncApi } from "@/lib/sync-api";
import { AttachmentPicker } from "./AttachmentPicker";
import { DriveReferenceDetails } from "./DriveReferenceDetails";
import { DriveAccessRecovery } from "./DriveAccessRecovery";
import { ExportMarkdownButton } from "./ExportMarkdown";
import { FileIcon } from "./AttachmentThumbnail";
import { RenameAttachment } from "./RenameAttachment";
import { fileType, purged } from "./file-words";
import { formatSize } from "./format-size";
import "./attachment-preview.css";

export type AttachmentPreviewCommands = {
  open: (() => void) | null;
  more: (() => void) | null;
};
export type PreviewTarget =
  { uri: string } | { id: string; initial?: Attachment };
export type ReferenceReplacement = (
  file: Attachment,
  requestId: string,
  signal: AbortSignal,
) => Promise<void>;

/** Where a file is used, as the "Used in" list names each place. */
const usageKinds: Record<string, string> = {
  ticket_attachment: "Attached to the ticket",
  ticket_body: "Ticket description",
  document_body: "Document",
  activity_brief: "Update details",
  draft: "Unsaved draft",
  undo: "Kept for Undo",
};

/**
 * Where a media element loads the file from. WebKitGTK hands audio and video
 * to GStreamer, which cannot read the attachment-media scheme, so on Linux the
 * whole file is read once into a blob URL; elsewhere the scheme serves ranges.
 */
function usePlayableUrl(
  workspace: string,
  id: string,
  mime: string,
  url: string,
  onError: () => void,
): string | null {
  const buffered = isLinuxPlatform() && !mime.startsWith("image/");
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const failed = useRef(onError);
  useLayoutEffect(() => {
    failed.current = onError;
  });
  useEffect(() => {
    if (!buffered) return;
    let live = true;
    let created = "";
    attachments.mediaBlob(workspace, id, mime).then(
      (blob) => {
        if (!live) return;
        created = URL.createObjectURL(blob);
        setBlobUrl(created);
      },
      () => {
        if (live) failed.current();
      },
    );
    return () => {
      live = false;
      if (created) URL.revokeObjectURL(created);
      setBlobUrl(null);
    };
  }, [buffered, workspace, id, mime]);
  return buffered ? blobUrl : url;
}

function Media({
  workspace,
  file,
  mime,
  url: schemeUrl,
  onError,
}: {
  workspace: string;
  file: Attachment;
  mime: string;
  url: string;
  onError: () => void;
}) {
  const url = usePlayableUrl(workspace, file.id, mime, schemeUrl, onError);
  const media = useRef<HTMLMediaElement>(null);
  const image = useRef<HTMLImageElement>(null);
  useEffect(() => {
    if (url === null) return;
    const element = media.current;
    const picture = image.current;
    // Strict Mode rehearses cleanup/setup; restore sources on each setup too.
    picture?.setAttribute("src", url);
    element?.setAttribute("src", url);
    return () => {
      picture?.removeAttribute("src");
      if (!element) return;
      element.pause();
      element.removeAttribute("src");
      element.load();
    };
  }, [url]);
  if (mime.startsWith("image/"))
    return (
      <img
        ref={image}
        className="attachment-preview-image"
        src={schemeUrl}
        alt={file.display_name}
        onError={onError}
      />
    );
  const props = {
    ...(url === null ? {} : { src: url }),
    controls: true,
    preload: "metadata",
    onError,
    "aria-label": file.display_name,
  } as const;
  return mime.startsWith("audio/") ? (
    <audio
      {...props}
      ref={(node) => {
        media.current = node;
      }}
    />
  ) : (
    <video
      {...props}
      ref={(node) => {
        media.current = node;
      }}
    />
  );
}

/**
 * Everything the preview knows and does about one file, shared by the viewer
 * dialog and the library's detail pane. Viewing never edits content.
 */
function usePreview(target: PreviewTarget) {
  const [file, setFile] = useState<Attachment | null>(
    "initial" in target ? (target.initial ?? null) : null,
  );
  const [info, setInfo] = useState<PreviewInfo | null>(null);
  const [copy, setCopy] = useState<DriveCopyInspection | null>(null);
  const [workspace, setWorkspace] = useState("");
  const [attempt, setAttempt] = useState(0);
  const refreshDrive = useCallback(() => setAttempt((value) => value + 1), []);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState<FailureDescription | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const id = "id" in target ? target.id : undefined;
  const uri = "uri" in target ? target.uri : undefined;
  const availability = useAvailability(
    file && file.kind !== "external_reference" ? [file.id] : [],
  );
  const stored = file ? availability.of(file.id) : undefined;
  // The bytes are still in Drive, or on their way: there is nothing to preview
  // yet. Once they arrive the preview is read again.
  const awaited = stored !== undefined && stored.state !== "downloaded";
  const absent = stored?.state === "not_downloaded" ? stored.id : "";
  const { download } = availability;
  // Where Attachments download when opened, opening one is what fetches it:
  // once per file, so a download that failed waits for the Download button.
  const fetched = useRef("");
  useEffect(() => {
    if (!absent || fetched.current === absent) return;
    fetched.current = absent;
    void syncApi
      .settings()
      .then((settings) =>
        settings.attachment_download === "on_open"
          ? download(absent)
          : undefined,
      )
      .catch((reason: unknown) =>
        setError(describeFailure(reason, "download the file")),
      );
  }, [absent, download]);
  useEffect(() => {
    const current = ++generation.current;
    void (async () => {
      const owningWorkspace = await attachments.workspaceId();
      const resolvedFile = id ? null : await attachments.resolve(uri ?? "");
      if (resolvedFile && generation.current === current) setFile(resolvedFile);
      const resolved = id ?? resolvedFile?.id ?? "";
      const preview = await attachments.preview(owningWorkspace, resolved);
      if (generation.current !== current) return;
      setWorkspace(owningWorkspace);
      setFile(preview.attachment);
      setInfo(preview);
      setCopy(null);
      if (preview.attachment.kind === "external_reference") {
        const inspection = await attachments.inspectDriveCopy(resolved);
        if (generation.current === current) setCopy(inspection);
      }
    })().catch((reason: unknown) => {
      if (generation.current === current)
        setError(describeFailure(reason, "load the preview"));
    });
    return () => {
      generation.current += 1;
    };
  }, [id, uri, attempt, awaited]);
  async function action(verb: string, run: () => Promise<void>) {
    const current = generation.current;
    setBusy(true);
    setError(null);
    try {
      await run();
    } catch (reason) {
      if (generation.current === current)
        setError(describeFailure(reason, verb));
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }
  function mediaFailed() {
    setFailed(true);
    if (!file) return;
    const current = generation.current;
    // A decode error alone cannot distinguish unsupported codecs from lost bytes.
    void attachments
      .preview(workspace, file.id)
      .then((next) => {
        if (generation.current === current) {
          setInfo(next);
          setFile(next.attachment);
        }
      })
      .catch(() => {});
  }
  /** Reads the file again: after a transient failure, or a change elsewhere. */
  function retry() {
    setInfo(null);
    setFailed(false);
    setError(null);
    setAttempt((value) => value + 1);
  }
  function renamed(next: Attachment) {
    setFile(next);
    setInfo((previous) =>
      previous ? { ...previous, attachment: next } : null,
    );
  }
  const external = file?.kind === "external_reference";
  const uploadedCopy =
    file?.uploaded_copy === true ||
    info?.uploaded_copy === true ||
    copy !== null;
  return {
    file,
    info,
    copy,
    workspace,
    attempt,
    refreshDrive,
    failed,
    mediaFailed,
    retry,
    renamed,
    error,
    setError,
    busy,
    action,
    availability,
    stored,
    awaited,
    external,
    uploadedCopy,
    gone: file ? purged(file) : false,
    // A file still in Drive reads as missing here; it is waiting, not lost.
    missing:
      !awaited &&
      availability.known &&
      (info?.status === "missing" || info?.status === "incomplete"),
    link:
      workspace && file ? `<ticketd://attachment/${workspace}/${file.id}>` : "",
  };
}

type Preview = ReturnType<typeof usePreview>;

/** "On this computer", "Google Drive · Uploaded copy", "Not downloaded". */
function storedWord(preview: Preview) {
  if (preview.external)
    return preview.uploadedCopy
      ? "Google Drive · Uploaded copy"
      : "Google Drive · External reference";
  return storageWord(preview.stored);
}

/** Why Open can't work right now, or null when it can. */
function openBlocked(preview: Preview): string | null {
  if (preview.gone) return "Its stored copy was deleted.";
  if (preview.missing) return "The file is missing from this computer.";
  if (preview.awaited) return "Download the file first.";
  if (preview.info?.can_open === false)
    return "No app on this computer opens it.";
  return null;
}

/**
 * The header row: the file's glyph and name, then Open (the one primary),
 * Export, Copy link, "…" and Close. Rename edits the name in place.
 */
function PreviewHeader({
  preview,
  title,
  onClose,
  close,
  onReplace,
  onChanged,
  menuItems,
  renaming,
  onRenamingChange,
  pane = false,
  onCommandsChange,
}: {
  preview: Preview;
  /** The heading element: the dialog's title, or the pane's h2. */
  title: (name: string) => ReactNode;
  onClose: () => void;
  /** The close button: DialogClose in the viewer, a plain button in a pane. */
  close: (button: ReactNode) => ReactNode;
  onReplace: (() => void) | undefined;
  onChanged: (() => void) | undefined;
  menuItems: ReactNode;
  pane?: boolean;
  onCommandsChange?:
    ((commands: AttachmentPreviewCommands | null) => void) | undefined;
  renaming: boolean;
  onRenamingChange: (renaming: boolean) => void;
}) {
  const { file, info, busy, external, uploadedCopy, workspace } = preview;
  const family = fileType(
    file?.original_filename ?? "",
    info?.media_type,
  ).family;
  const blocked = openBlocked(preview);
  const canRestore = Boolean(file?.quarantined) && !preview.gone;
  const notDownloaded = preview.stored?.state === "not_downloaded";
  const [moreOpen, setMoreOpen] = useState(false);
  const moreTrigger = useRef<HTMLButtonElement>(null);
  const wasRenaming = useRef(renaming);
  useLayoutEffect(() => {
    if (
      wasRenaming.current &&
      !renaming &&
      document.activeElement === document.body
    )
      moreTrigger.current?.focus({ preventScroll: true });
    wasRenaming.current = renaming;
  }, [renaming]);
  const open = useCallback(() => {
    if (file && !busy && blocked === null)
      void preview.action("open the file", () => attachments.open(file.id));
  }, [file, busy, blocked, preview]);
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);
  const canOpen = Boolean(file) && !busy && blocked === null;
  const callbacks = useMemo<AttachmentPreviewCommands>(
    () => ({
      open: canOpen ? () => openRef.current() : null,
      more: file && !busy ? () => setMoreOpen(true) : null,
    }),
    [canOpen, file, busy],
  );
  useEffect(() => {
    onCommandsChange?.(callbacks);
    return () => onCommandsChange?.(null);
  }, [callbacks, onCommandsChange]);
  const openButton = file && (
    <Button
      variant="outline"
      size="sm"
      aria-keyshortcuts={ariaKeyShortcuts("attachments-open")}
      disabled={busy || blocked !== null}
      // The visible "Open" names what it opens for assistive technology.
      aria-label={external ? "Open in Drive" : "Open file"}
      onClick={open}
    >
      {external ? "Open in Drive" : "Open"}
    </Button>
  );
  return (
    <PaneHeader
      title={file?.display_name ?? "Attachment"}
      titleLevel={2}
      icon={<FileIcon family={family} />}
      leading={
        pane ? (
          <IconButton
            label="Back to Attachments"
            shortcut={shortcutLabel("attachments-back")}
            aria-keyshortcuts={ariaKeyShortcuts("attachments-back")}
            onClick={onClose}
          >
            <ArrowLeft />
          </IconButton>
        ) : undefined
      }
      titleEditor={
        renaming && file ? (
          <RenameAttachment
            file={file}
            onClose={() => onRenamingChange(false)}
            onRenamed={(next) => {
              preview.renamed(next);
              onChanged?.();
            }}
          />
        ) : (
          <span className="attachment-preview-title">
            {title(file?.display_name ?? "Attachment")}
          </span>
        )
      }
      actions={
        !renaming && (
          <span className="attachment-preview-actions">
            {openButton &&
              (blocked ? (
                <Tooltip content={blocked}>
                  {/* A disabled button takes no pointer events; its wrapper keeps the reason. */}
                  <span tabIndex={0} className="inline-flex">
                    {openButton}
                  </span>
                </Tooltip>
              ) : (
                <Tooltip
                  content={external ? "Open in Drive" : "Open file"}
                  shortcut={shortcutLabel("attachments-open")}
                >
                  {openButton}
                </Tooltip>
              ))}
            {file && external && workspace && (
              <ExportMarkdownButton
                compact
                label={uploadedCopy ? "Export" : "Export link"}
                source={{
                  kind: "markdown",
                  body: `<ticketd://attachment/${workspace}/${file.id}>`,
                }}
              />
            )}
            {file && !external && (
              <IconButton
                label="Export file"
                disabled={busy || preview.gone}
                onClick={() =>
                  void preview.action("export the file", () =>
                    attachments.export(file),
                  )
                }
              >
                <Download />
              </IconButton>
            )}
            {preview.link && !preview.gone && !file?.quarantined && (
              <CopyButton
                text={preview.link}
                label="Copy link"
                icon={<Link />}
              />
            )}
            {file && (
              <DropdownMenu open={moreOpen} onOpenChange={setMoreOpen}>
                <DropdownMenuTrigger asChild>
                  <IconButton
                    ref={moreTrigger}
                    label="More actions"
                    shortcut={shortcutLabel("attachments-more")}
                    aria-keyshortcuts={ariaKeyShortcuts("attachments-more")}
                    disabled={busy}
                  >
                    <Ellipsis />
                  </IconButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => onRenamingChange(true)}>
                    Rename…
                  </DropdownMenuItem>
                  {onReplace && (
                    <DropdownMenuItem onSelect={onReplace}>
                      Replace…
                    </DropdownMenuItem>
                  )}
                  {notDownloaded && (
                    <DropdownMenuItem
                      onSelect={() =>
                        void preview.action("download the file", () =>
                          preview.availability.download(file.id),
                        )
                      }
                    >
                      Download
                    </DropdownMenuItem>
                  )}
                  {canRestore && (
                    <DropdownMenuItem
                      onSelect={() =>
                        void preview.action("restore the file", async () => {
                          await attachments.restore(
                            file.id,
                            crypto.randomUUID(),
                          );
                          preview.retry();
                          onChanged?.();
                        })
                      }
                    >
                      Restore
                    </DropdownMenuItem>
                  )}
                  {menuItems && (
                    <>
                      <DropdownMenuSeparator />
                      {menuItems}
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {!pane &&
              close(
                <IconButton label="Close" onClick={onClose}>
                  <X />
                </IconButton>,
              )}
          </span>
        )
      }
    />
  );
}

/** The recessed stage: the file itself, or one plain sentence about why not. */
function PreviewStage({
  preview,
  onReplace,
  onRestoreBackup,
  onChanged,
}: {
  preview: Preview;
  onReplace: (() => void) | undefined;
  onRestoreBackup: (() => void) | undefined;
  onChanged: (() => void) | undefined;
}) {
  const { file, info, busy, error, external, awaited, failed } = preview;
  const type = fileType(file?.original_filename ?? "", info?.media_type);
  const notice = file?.quarantined && !preview.gone && (
    <Alert size="compact">
      <AlertDescription>
        Quarantined. Restore it to use it in new places.
      </AlertDescription>
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() =>
          void preview.action("restore the file", async () => {
            await attachments.restore(file.id, crypto.randomUUID());
            preview.retry();
            onChanged?.();
          })
        }
      >
        Restore file
      </Button>
    </Alert>
  );
  let body: ReactNode;
  if (external && file)
    body = (
      <DriveAccessRecovery
        id={file.id}
        onRefresh={preview.refreshDrive}
        uploadedCopy={preview.uploadedCopy}
        copy={preview.copy}
      />
    );
  else if (file?.purge_state === "purged")
    body = (
      <EmptyState
        title="Deleted permanently"
        description="Its name stays in ticketd. The file itself can only come back from an older backup."
        {...(onRestoreBackup && {
          action: (
            <Button variant="outline" size="sm" onClick={onRestoreBackup}>
              Restore from a backup…
            </Button>
          ),
        })}
      />
    );
  else if (file?.purge_state === "pending")
    body = (
      <EmptyState
        title="Deleting permanently"
        description="ticketd started deleting its stored copy. Finish deleting it from the Attachments library."
      />
    );
  else if (preview.missing)
    body = (
      <Alert tone="attention" className="max-w-120">
        <AlertTitle>
          {info?.status === "incomplete"
            ? "This file is incomplete on this computer"
            : "This file is missing from this computer"}
        </AlertTitle>
        <AlertDescription>
          It may have been moved or deleted outside ticketd. Its name and the
          places that use it are kept.
        </AlertDescription>
        {(onReplace || onRestoreBackup) && (
          <AlertActions>
            {onReplace && (
              <Button variant="outline" size="sm" onClick={onReplace}>
                Replace file…
              </Button>
            )}
            {onRestoreBackup && (
              <Button variant="ghost" size="sm" onClick={onRestoreBackup}>
                Restore from a backup…
              </Button>
            )}
          </AlertActions>
        )}
      </Alert>
    );
  else if (awaited && file)
    body = (
      <div className="attachment-preview-awaited">
        <EmptyState
          icon={<FileIcon family={type.family} />}
          title={storageWord(preview.stored)}
          description="This file is in your Google Drive."
          role="status"
          {...(preview.stored?.state === "not_downloaded" && {
            action: (
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  void preview.action("download the file", () =>
                    preview.availability.download(file.id),
                  )
                }
              >
                <Download aria-hidden="true" />
                Download
              </Button>
            ),
          })}
        />
        {error && <FailureAlert size="compact" failure={error} />}
      </div>
    );
  else if (failed && file)
    body = (
      <FailureState
        failure={{
          code: "failed",
          title: `Couldn't show this ${type.word.toLowerCase()}`,
          sentence:
            "ticketd may not play how it was saved. Open it in its app, or retry.",
          action: "retry",
          details: "",
        }}
        onRetry={preview.retry}
      />
    );
  else if (info?.status === "available" && file && info.media_type)
    body = (
      <Media
        key={`${preview.workspace}/${file.id}/${preview.attempt}`}
        workspace={preview.workspace}
        file={file}
        mime={info.media_type}
        url={attachments.mediaUrl(preview.workspace, file.id)}
        onError={preview.mediaFailed}
      />
    );
  else if (info?.status === "unavailable")
    body = (
      <FailureState
        failure={{
          code: "failed",
          title: "Couldn't read this file",
          sentence: "ticketd can't read its stored copy on this computer.",
          action: "retry",
          details: info.message ?? "",
        }}
        onRetry={preview.retry}
      />
    );
  else if (info?.text_excerpt)
    body = (
      <div className="attachment-preview-textual">
        <pre
          className="attachment-preview-text"
          aria-label={`Text of ${file?.display_name ?? "the file"}`}
          tabIndex={0}
        >
          {info.text_excerpt.text}
        </pre>
        {info.text_excerpt.truncated && (
          <p className="attachment-preview-text-note">
            Showing the start of the file. Open it to read the rest.
          </p>
        )}
      </div>
    );
  else if (info?.status === "too_large")
    body = (
      <EmptyState
        icon={<FileIcon family={type.family} />}
        title="Too large to preview"
        description="Open it in its app to see it."
      />
    );
  else if (info)
    body = (
      <EmptyState
        icon={<FileIcon family={type.family} />}
        title={
          type.family === "file"
            ? "No preview for this file"
            : `No preview for ${type.word} files`
        }
        description="Open it in its app to see it."
      />
    );
  else if (error && !awaited)
    body = <FailureState failure={error} onRetry={preview.retry} />;
  else
    body = (
      <div
        role="status"
        aria-label="Loading preview"
        className="attachment-preview-loading"
      >
        <Skeleton className="h-full w-full" />
      </div>
    );
  return (
    <div
      className="attachment-preview-stage"
      data-image={
        type.family === "image" &&
        !preview.missing &&
        !preview.gone &&
        !external
          ? ""
          : undefined
      }
    >
      {notice}
      <div className="attachment-preview-canvas">{body}</div>
    </div>
  );
}

/** The facts under (or beside) the stage: storage, type, size, age, uses. */
function PreviewFacts({
  preview,
  onNavigate,
  actions,
}: {
  preview: Preview;
  onNavigate: () => void;
  actions: ReactNode;
}) {
  const { file, info, external, uploadedCopy, attempt } = preview;
  const openDocument = useContext(DocumentNavigation);
  const openTicket = useContext(TicketNavigation);
  if (!file) return null;
  const type = fileType(file.original_filename, info?.media_type);
  return (
    <div className="attachment-preview-facts">
      <dl className="attachment-facts">
        {external ? (
          <DriveReferenceDetails
            id={file.id}
            revision={attempt}
            uploadedCopy={uploadedCopy}
          />
        ) : (
          <>
            <dt>Stored</dt>
            <dd>{storedWord(preview)}</dd>
            <dt>Type</dt>
            <dd>{type.word}</dd>
            <dt>Size</dt>
            <dd>
              {file.size_bytes != null
                ? formatSize(file.size_bytes)
                : "Not recorded"}
            </dd>
          </>
        )}
        <dt>Added</dt>
        <dd>
          {file.added_at ? (
            <Time value={file.added_at} />
          ) : (
            <span className="attachment-facts-muted">Not recorded</span>
          )}
        </dd>
        {file.original_filename !== file.display_name && (
          <>
            <dt>Original name</dt>
            <dd className="attachment-facts-name">{file.original_filename}</dd>
          </>
        )}
        <dt>Used in</dt>
        <dd>
          {!info ? (
            <span className="attachment-facts-muted">…</span>
          ) : info.usage.total === 0 ? (
            info.usage.legacy_drafts_pending ? (
              "Kept for recovery"
            ) : (
              "Unused"
            )
          ) : (
            <>
              <h3 className="sr-only">Used in {info.usage.total}</h3>
              <ul className="attachment-uses" aria-label="Attachment usage">
                {info.usage.entries.map((entry) => (
                  <li key={`${entry.kind}:${entry.owner}`}>
                    {(entry.target?.kind === "ticket" && openTicket) ||
                    (entry.target?.kind === "document" && openDocument) ? (
                      <RecordLink
                        onClick={() => {
                          onNavigate();
                          if (entry.target?.kind === "ticket")
                            openTicket?.(entry.target.id);
                          else if (entry.target?.kind === "document")
                            openDocument?.(entry.target.id);
                        }}
                      >
                        {entry.label}
                      </RecordLink>
                    ) : (
                      <span>{entry.label}</span>
                    )}
                    <small>
                      {usageKinds[entry.kind] ?? entry.kind}
                      {entry.trashed ? " · In Trash" : ""}
                    </small>
                  </li>
                ))}
              </ul>
              {info.usage.total > info.usage.entries.length && (
                <small className="attachment-facts-muted">
                  And {info.usage.total - info.usage.entries.length} more.
                </small>
              )}
            </>
          )}
        </dd>
      </dl>
      {actions && <div className="attachment-preview-extra">{actions}</div>}
    </div>
  );
}

/** The failure of the last action (open, export, rename, restore), in place. */
function PreviewFailure({ preview }: { preview: Preview }) {
  // While the file waits in Drive, or nothing loaded, the stage shows it.
  if (!preview.error || preview.awaited || !preview.info) return null;
  return (
    <div className="attachment-preview-failure">
      <FailureAlert size="compact" failure={preview.error} />
    </div>
  );
}

/**
 * The viewer: a file opened from a ticket, a Document or a Chat. The `viewer`
 * dialog size with one header (Open, Export, Copy link, "…", Close), the
 * stage and the facts; no footer. Replace… swaps the viewer for the picker
 * instead of stacking a second dialog.
 */
export function AttachmentPreview({
  target,
  onClose,
  onReplace,
  actions,
}: {
  target: PreviewTarget;
  onClose: () => void;
  onReplace?: ReferenceReplacement | undefined;
  actions?: ReactNode;
}) {
  const preview = usePreview(target);
  const presence = useDialogPresence(onClose);
  const [picking, setPicking] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const replacementRequest = useRef<AbortController | null>(null);
  const openSettings = useContext(SettingsNavigation);
  useEffect(() => () => replacementRequest.current?.abort(), []);
  function close() {
    replacementRequest.current?.abort();
    presence.close();
  }
  const replace = onReplace
    ? () => {
        replacementRequest.current?.abort();
        replacementRequest.current = new AbortController();
        setPicking(true);
      }
    : undefined;
  const { file } = preview;
  if (picking && onReplace && file)
    return (
      <AttachmentPicker
        open
        single
        replacing={file.display_name}
        onOpenChange={(open) => {
          if (open) return;
          replacementRequest.current?.abort();
          setPicking(false);
        }}
        onPick={async (replacement, requestId) => {
          if (replacement.id === file.id)
            throw new Error(
              "That file is already attached here. Choose a different file.",
            );
          const signal = replacementRequest.current?.signal;
          if (!signal)
            throw new Error("Select the reference again before replacing it.");
          signal.throwIfAborted();
          await onReplace(replacement, requestId, signal);
          close();
        }}
      />
    );
  return (
    <Dialog
      open={presence.dialog.open}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        variant="flush"
        size="viewer"
        showCloseButton={false}
        inert={!presence.dialog.open || undefined}
        onCloseAutoFocus={() => {
          if (!presence.dialog.open) presence.dialog.onExitComplete();
        }}
      >
        <div className="attachment-preview" data-layout="viewer">
          <PreviewHeader
            preview={preview}
            title={(name) => <DialogTitle>{name}</DialogTitle>}
            onClose={close}
            close={(button) => <DialogClose asChild>{button}</DialogClose>}
            onReplace={replace}
            onChanged={undefined}
            menuItems={null}
            renaming={renaming}
            onRenamingChange={setRenaming}
          />
          <DialogDescription className="sr-only">
            {file
              ? `${fileType(file.original_filename).word} preview`
              : "Preview"}
          </DialogDescription>
          <div className="attachment-preview-body">
            <PreviewStage
              preview={preview}
              onReplace={replace}
              onRestoreBackup={
                openSettings
                  ? () => {
                      close();
                      openSettings("backups");
                    }
                  : undefined
              }
              onChanged={undefined}
            />
            <PreviewFacts
              preview={preview}
              onNavigate={close}
              actions={actions}
            />
            <PreviewFailure preview={preview} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The library's detail pane: the same header, stage and facts as the viewer,
 * in a pane beside the list. `menuItems` adds the library's own actions
 * (Delete permanently…, Remove from ticketd…) after a separator in "…";
 * `onChanged` refreshes the list after a rename or restore.
 */
export function AttachmentPreviewPane({
  file: initial,
  onClose,
  onChanged,
  menuItems,
  renameRequest = 0,
  onCommandsChange,
}: {
  file: Attachment;
  onClose: () => void;
  onChanged: () => void;
  menuItems?: ReactNode;
  /** Bumped by the list's "Rename…" to start renaming in the header. */
  renameRequest?: number;
  onCommandsChange?: (commands: AttachmentPreviewCommands | null) => void;
}) {
  const preview = usePreview({ id: initial.id, initial });
  const [renaming, setRenaming] = useState(renameRequest > 0);
  const [seenRename, setSeenRename] = useState(renameRequest);
  if (seenRename !== renameRequest) {
    setSeenRename(renameRequest);
    if (renameRequest > 0) setRenaming(true);
  }
  const openSettings = useContext(SettingsNavigation);
  const titleId = `attachment-preview-${initial.id}`;
  const paneRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    paneRef.current?.querySelector<HTMLElement>("h2")?.focus();
  }, []);
  return (
    <section
      ref={paneRef}
      className="attachment-preview"
      data-layout="pane"
      aria-labelledby={titleId}
      onKeyDown={(event) => {
        if (
          event.target instanceof HTMLElement &&
          event.target.closest(
            "input, textarea, [contenteditable], [role='menu']",
          )
        )
          return;
        if (matchesShortcut(event, "attachments-open")) {
          event.preventDefault();
          event.currentTarget
            .querySelector<HTMLButtonElement>(
              "[aria-label='Open file'], [aria-label='Open in Drive']",
            )
            ?.click();
        }
        if (matchesShortcut(event, "attachments-more")) {
          event.preventDefault();
          event.currentTarget
            .querySelector<HTMLButtonElement>("[aria-label='More actions']")
            ?.dispatchEvent(
              new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
            );
        }
      }}
    >
      <PreviewHeader
        pane
        onCommandsChange={onCommandsChange}
        preview={preview}
        title={(name) => (
          <h2 tabIndex={-1} id={titleId}>
            {name}
          </h2>
        )}
        onClose={onClose}
        close={(button) => button}
        onReplace={undefined}
        onChanged={onChanged}
        menuItems={menuItems}
        renaming={renaming}
        onRenamingChange={setRenaming}
      />
      <div className="attachment-preview-body">
        <PreviewStage
          preview={preview}
          onReplace={undefined}
          onRestoreBackup={
            openSettings ? () => openSettings("backups") : undefined
          }
          onChanged={onChanged}
        />
        <PreviewFacts preview={preview} onNavigate={() => {}} actions={null} />
        <PreviewFailure preview={preview} />
      </div>
    </section>
  );
}
