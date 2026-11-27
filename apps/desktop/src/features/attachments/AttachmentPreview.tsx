import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  CloudDownload,
  Download,
  Ellipsis,
  Info,
  Link,
  PanelRight,
  Pencil,
  RefreshCw,
  RotateCcw,
  X,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
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
import { FailureAlert, FailureState } from "@/components/ui/failure-alert";
import { PaneHeader, ShellSlotProvider } from "@/components/ui/list-header";
import {
  ariaKeyShortcuts,
  matchesShortcut,
  shortcutLabel,
} from "@/lib/shortcuts";
import { IconButton } from "@/components/ui/icon-button";
import { Progress } from "@/components/ui/progress";
import { useCopy } from "@/components/ui/use-copy";
import { useStatusLine } from "@/components/ui/use-status-line";
import { setPreference, usePreferences } from "@/lib/preferences";
import { RecordLink } from "@/components/ui/record-link";
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
import { syncApi } from "@/lib/sync-api";
import { storageName } from "@/features/sync/storage-name";
import { useSyncStatus } from "@/features/sync/sync-status";
import { AttachmentPicker } from "./AttachmentPicker";
import { DriveReferenceDetails } from "./DriveReferenceDetails";
import { DriveAccessRecovery } from "./DriveAccessRecovery";
import { ExportMarkdownButton } from "./ExportMarkdown";
import { FileIcon } from "./AttachmentThumbnail";
import { FittedTitle } from "./FittedTitle";
import { HtmlStage } from "./HtmlStage";
import { ImageStage } from "./ImageStage";
import { PdfStage, type StageKeys } from "./PdfStage";
import { SVG_LIMIT, SvgStage } from "./SvgStage";
import { TextStage } from "./TextStage";
import { PreviewLoading, PreviewState, RetryActions } from "./PreviewState";
import { RenameAttachment } from "./RenameAttachment";
import { extensionLabel, fileType, purged } from "./file-words";
import { formatProgress, formatSize } from "./format-size";
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

/** The largest file the app previews at all (100 MiB); a picture under it that is too large has too many pixels. */
const PREVIEW_BYTES = 100 * 1024 * 1024;

/** Where a file is used, as the "Used in" list names each place. */
const usageKinds: Record<string, string> = {
  ticket_attachment: "Attached to the ticket",
  ticket_body: "Ticket description",
  document_body: "Document",
  activity_brief: "Update details",
  draft: "Unsaved draft",
  undo: "Kept for Undo",
};

function Media({
  file,
  mime,
  url,
  onError,
}: {
  file: Attachment;
  mime: string;
  url: string;
  onError: () => void;
}) {
  const media = useRef<HTMLMediaElement>(null);
  useEffect(() => {
    const element = media.current;
    // Strict Mode rehearses cleanup/setup; restore the source on each setup too.
    element?.setAttribute("src", url);
    return () => {
      if (!element) return;
      element.pause();
      element.removeAttribute("src");
      element.load();
    };
  }, [url]);
  const props = {
    src: url,
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
function usePreview(target: PreviewTarget, warm?: Map<string, PreviewInfo>) {
  const initial = "initial" in target ? (target.initial ?? null) : null;
  const [file, setFile] = useState<Attachment | null>(initial);
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
  // The viewer steps through files without remounting: a new target starts from
  // nothing of the last one's state. A neighbor read ahead shows at once and is
  // still read again, so the state shown is never older than this open.
  const identity = `${id ?? ""}|${uri ?? ""}`;
  const [shown, setShown] = useState(identity);
  if (shown !== identity) {
    setShown(identity);
    setFile(initial);
    setInfo((id && warm?.get(id)) || null);
    setCopy(null);
    setFailed(false);
    setError(null);
    setBusy(false);
  }
  const availability = useAvailability(
    file && file.kind !== "external_reference" ? [file.id] : [],
  );
  const stored = file ? availability.of(file.id) : undefined;
  // The bytes are still in the sync storage, or on their way: there is nothing to preview
  // yet. Once they arrive the preview is read again.
  const awaited = stored !== undefined && stored.state !== "downloaded";
  const absent = stored?.state === "not_downloaded" ? stored.id : "";
  const sync = useSyncStatus();
  // The storage wants the person back before it hands the file over.
  const signedOut =
    absent !== "" &&
    (sync.status?.recovery === "authorization_expired" ||
      error?.code === "not_signed_in" ||
      error?.code === "unauthenticated");
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
        setError(describeFailure(reason, "download")),
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
    signedOut,
    external,
    uploadedCopy,
    gone: file ? purged(file) : false,
    // A file still in the sync storage reads as missing here; it is waiting, not lost.
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

/** Why neither Open nor Export can work right now, or null when the bytes are here. */
function storedBlocked(preview: Preview): string | null {
  if (preview.gone) return "Its stored copy was deleted.";
  if (preview.missing) return "It’s missing from this computer.";
  if (preview.stored?.state === "downloading") return "Downloading…";
  if (preview.signedOut) return "Sign in to download it.";
  if (preview.awaited) return "Download it first.";
  if (!preview.external && preview.info?.status === "unavailable")
    return "ticketd can’t read the stored copy.";
  return null;
}

/** Why Open can't work right now, or null when it can. */
function openBlocked(preview: Preview): string | null {
  return (
    storedBlocked(preview) ??
    (preview.info?.can_open === false
      ? "No app on this computer opens it."
      : null)
  );
}

/** Under 880px wide the viewer is a sheet 12px from the window's edges. */
const COMPACT = "(max-width: 879px)";
function useCompact(): boolean {
  return useSyncExternalStore(
    (notify) => {
      if (typeof window.matchMedia !== "function") return () => {};
      const media = window.matchMedia(COMPACT);
      media.addEventListener("change", notify);
      return () => media.removeEventListener("change", notify);
    },
    () =>
      typeof window.matchMedia === "function" &&
      window.matchMedia(COMPACT).matches,
    () => false,
  );
}

/** Export, the tray icon (the one Drive references use too); while the bytes are not here it keeps its place and says why. */
function exportButton(
  file: Attachment,
  busy: boolean,
  blocked: string | null,
  preview: Preview,
) {
  const button = (
    <IconButton
      label="Export file"
      disabled={busy || blocked !== null}
      onClick={() =>
        void preview.action("export the file", () => attachments.export(file))
      }
    >
      <Download />
    </IconButton>
  );
  return blocked ? (
    <Tooltip content={blocked}>
      {/* A disabled button takes no pointer events; its wrapper keeps the reason. */}
      <span tabIndex={0} className="inline-flex">
        {button}
      </span>
    </Tooltip>
  ) : (
    button
  );
}

/** Where the viewer stands among the files of the place it was opened from. */
type Position = {
  /** 1-based. */
  index: number;
  total: number;
  step: (delta: -1 | 1) => void;
};

/**
 * "2 of 6", then Previous and Next. At an end the button that would go
 * further stays in place, disabled, and says why; the keys do nothing there.
 */
function BrowseControls({ position }: { position: Position }) {
  const { index, total, step } = position;
  const button = (delta: -1 | 1) => {
    const previous = delta < 0;
    const label = previous ? "Previous file" : "Next file";
    const key = previous ? "attachments-previous" : "attachments-next";
    const edge = previous ? index <= 1 : index >= total;
    const control = (
      <IconButton
        label={label}
        shortcut={shortcutLabel(key)}
        aria-keyshortcuts={ariaKeyShortcuts(key)}
        disabled={edge}
        onClick={() => step(delta)}
      >
        {previous ? (
          <ChevronLeft aria-hidden="true" />
        ) : (
          <ChevronRight aria-hidden="true" />
        )}
      </IconButton>
    );
    return edge ? (
      <Tooltip content={previous ? "First file" : "Last file"}>
        {/* A disabled button takes no pointer events; its wrapper keeps the reason. */}
        <span tabIndex={0} className="inline-flex">
          {control}
        </span>
      </Tooltip>
    ) : (
      control
    );
  };
  return (
    <span
      className="attachment-preview-browse"
      role="group"
      aria-label="Browse files"
    >
      <span className="attachment-preview-position">
        {index} of {total}
      </span>
      {button(-1)}
      {button(1)}
    </span>
  );
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
  details,
  compact = false,
  position,
  onCommandsChange,
}: {
  preview: Preview;
  /** Set when the viewer steps through several files. */
  position?: Position | undefined;
  /** The viewer's Details panel: shown or not, and the switch. */
  details?: { shown: boolean; toggle: () => void };
  /** A compact window: Export moves under "…". */
  compact?: boolean;
  /** The heading element: the dialog's title, or the pane's h2. */
  title: (name: ReactNode) => ReactElement;
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
  const exportBlocked = storedBlocked(preview);
  const statusLine = useStatusLine();
  const { copy } = useCopy();
  const copyLink = async () => {
    const done = await copy("link", preview.link);
    statusLine.show(
      done
        ? { message: "Copied link" }
        : {
            tone: "error",
            message: "Couldn’t copy the link. Select it and copy it instead.",
          },
    );
  };
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
          <FittedTitle
            name={file?.display_name ?? "Attachment"}
            heading={title}
          />
        )
      }
      actions={
        !renaming && (
          <span className="attachment-preview-actions">
            {position && <BrowseControls position={position} />}
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
            {file &&
              !external &&
              !compact &&
              exportButton(file, busy, exportBlocked, preview)}
            {pane && preview.link && !preview.gone && !file?.quarantined && (
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
                  {details && (
                    <DropdownMenuItem onSelect={details.toggle}>
                      <PanelRight aria-hidden="true" />
                      {details.shown ? "Hide details" : "Show details"}
                      <Kbd aria-hidden="true" className="ml-auto">
                        {shortcutLabel("attachments-details")}
                      </Kbd>
                    </DropdownMenuItem>
                  )}
                  {compact && file && !external && (
                    <DropdownMenuItem
                      disabled={exportBlocked !== null}
                      onSelect={() =>
                        void preview.action("export the file", () =>
                          attachments.export(file),
                        )
                      }
                    >
                      <Download aria-hidden="true" />
                      Export file
                    </DropdownMenuItem>
                  )}
                  {!pane &&
                    preview.link &&
                    !preview.gone &&
                    !file.quarantined && (
                      <DropdownMenuItem onSelect={() => void copyLink()}>
                        <Link aria-hidden="true" />
                        Copy link
                      </DropdownMenuItem>
                    )}
                  <DropdownMenuItem onSelect={() => onRenamingChange(true)}>
                    <Pencil aria-hidden="true" />
                    Rename…
                  </DropdownMenuItem>
                  {/* While the file is missing the stage offers Replace itself. */}
                  {onReplace && !(preview.missing && !pane) && (
                    <DropdownMenuItem onSelect={onReplace}>
                      <RefreshCw aria-hidden="true" />
                      Replace…
                    </DropdownMenuItem>
                  )}
                  {pane && notDownloaded && (
                    <DropdownMenuItem
                      onSelect={() =>
                        void preview.action("download the file", () =>
                          preview.availability.download(file.id),
                        )
                      }
                    >
                      <CloudDownload aria-hidden="true" />
                      Download
                    </DropdownMenuItem>
                  )}
                  {pane && canRestore && (
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
                      <RotateCcw aria-hidden="true" />
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
  stageRef,
  place,
  fading = false,
}: {
  preview: Preview;
  /** The viewer's stage takes focus when it opens, so the reading keys work at once. */
  stageRef?: RefObject<HTMLDivElement | null>;
  /** "2 of 6", when the viewer steps through files. */
  place?: string | undefined;
  /** A file reached by Previous or Next fades in; the first one does not. */
  fading?: boolean;
  onReplace: (() => void) | undefined;
  onRestoreBackup: (() => void) | undefined;
  onChanged: (() => void) | undefined;
}) {
  const { file, info, busy, error, external, awaited, failed } = preview;
  const { apply, status: syncStatus } = useSyncStatus();
  const scroller = useRef<HTMLDivElement | null>(null);
  const stageKeys: StageKeys = useRef(null);
  // The stage is also the scroller the formats lay themselves out in.
  const stage = useCallback(
    (element: HTMLDivElement | null) => {
      scroller.current = element;
      if (stageRef) stageRef.current = element;
    },
    [stageRef],
  );
  const type = fileType(file?.original_filename ?? "", info?.media_type);
  const provider = syncStatus?.provider;
  const storage = storageName(provider);
  const label = extensionLabel(file?.original_filename ?? "");
  // What the one sentence says a person can do with a file that has no preview.
  const see =
    type.family === "video"
      ? "watch it"
      : type.family === "audio"
        ? "listen to it"
        : "see it";
  const notice = file?.quarantined && !preview.gone && (
    <Alert size="compact">
      <Info aria-hidden="true" />
      <AlertDescription>
        Quarantined. Restore it to use it in new places.
      </AlertDescription>
      <Button
        variant="outline"
        size="compact"
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
  let reportShown = false;
  let pdfShown = false;
  let pictureShown = false;
  let textShown = false;
  if (external && file)
    body = (
      <DriveAccessRecovery
        id={file.id}
        onRefresh={preview.refreshDrive}
        uploadedCopy={preview.uploadedCopy}
        copy={preview.copy}
        family={type.family}
        label={`${label === "FILE" ? "DRIVE" : label} ↗`}
      />
    );
  else if (file?.purge_state === "purged")
    body = (
      <PreviewState
        family={type.family}
        label={label}
        title="Deleted permanently"
        sentence="Its name stays in ticketd. The file itself can only come back from an older backup."
        action={
          onRestoreBackup && (
            <Button variant="outline" size="sm" onClick={onRestoreBackup}>
              Restore from a backup…
            </Button>
          )
        }
      />
    );
  else if (file?.purge_state === "pending")
    body = (
      <PreviewState
        family={type.family}
        label={label}
        title="Deleting permanently"
        sentence="ticketd started deleting its stored copy. Finish deleting it from the Attachments library."
      />
    );
  else if (preview.missing)
    body = (
      <PreviewState
        family={type.family}
        label={label}
        attention
        title={
          info?.status === "incomplete"
            ? "Incomplete on this computer"
            : "Missing from this computer"
        }
        sentence="It may have been moved or deleted outside ticketd. Its name and the places that use it are kept."
        action={
          <>
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
          </>
        }
      />
    );
  else if (awaited && file) {
    const downloading = preview.stored?.state === "downloading";
    const size = file.size_bytes;
    const percent = preview.stored?.progress ?? null;
    const download = () =>
      void preview.action("download", () =>
        preview.availability.download(file.id),
      );
    const failure = preview.stored?.failure ?? null;
    const where = provider === "s3" ? storage.place : storage.full;
    if (preview.signedOut && !downloading)
      body = (
        <PreviewState
          family={type.family}
          label={label}
          role="status"
          attention
          title="Needs sign-in"
          sentence={`Sign in to ${provider === "s3" ? "AWS" : "Google"} to download this file.`}
          action={
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void preview.action("sign in", async () => {
                  apply(await syncApi.recover());
                })
              }
            >
              Sign in
            </Button>
          }
          extra={error && <FailureAlert size="compact" failure={error} />}
        />
      );
    else if (error && !downloading)
      body = (
        <PreviewState
          family={type.family}
          label={label}
          role="alert"
          title={error.title}
          sentence={error.sentence}
          action={<RetryActions onRetry={download} details={error.details} />}
        />
      );
    else if (failure !== null && !downloading)
      body = (
        <PreviewState
          family={type.family}
          label={label}
          role="alert"
          title="Couldn’t download"
          sentence={`${storage.full} didn’t answer. Nothing changed on this computer.`}
          action={
            <RetryActions
              onRetry={download}
              details={failure}
              disabled={busy}
            />
          }
        />
      );
    else
      body = (
        <PreviewState
          family={type.family}
          label={label}
          role="status"
          title={downloading ? "Downloading…" : "Not downloaded"}
          sentence={
            downloading
              ? size !== null && percent !== null
                ? formatProgress((size * Math.min(percent, 100)) / 100, size)
                : ""
              : `It’s in ${where}. Download it to preview it here.`
          }
          action={
            downloading ? (
              size !== null && percent !== null ? (
                <span className="attachment-state-progress">
                  <Progress value={percent} aria-label="Download progress" />
                </span>
              ) : null
            ) : preview.stored?.state === "not_downloaded" ? (
              <Button size="sm" disabled={busy} onClick={download}>
                <CloudDownload aria-hidden="true" />
                Download{size !== null && ` · ${formatSize(size)}`}
              </Button>
            ) : null
          }
        />
      );
  } else if (info && !preview.availability.known)
    // Until the storage says where the bytes are, a file read ahead must not
    // be read, nor taken for one with no preview: it may still be in Drive.
    body = <PreviewLoading shape={type.family === "pdf" ? "page" : "block"} />;
  else if (failed && file)
    body = (
      <PreviewState
        family={type.family}
        label={label}
        role="alert"
        title={`Couldn’t show this ${type.word.toLowerCase()}`}
        sentence="ticketd may not play how it was saved. Open it in its app, or retry."
        action={<RetryActions onRetry={preview.retry} />}
      />
    );
  else if (info?.status === "available" && file && info.media_type) {
    const mediaKey = `${preview.workspace}/${file.id}/${preview.attempt}`;
    const mediaUrl = attachments.mediaUrl(preview.workspace, file.id);
    if (info.media_type.startsWith("image/")) {
      pictureShown = true;
      body = (
        <ImageStage
          key={mediaKey}
          file={file}
          url={mediaUrl}
          onError={preview.mediaFailed}
          scrollerRef={scroller}
          keysRef={stageKeys}
        />
      );
    } else
      body = (
        <Media
          key={mediaKey}
          file={file}
          mime={info.media_type}
          url={mediaUrl}
          onError={preview.mediaFailed}
        />
      );
  } else if (info?.status === "unavailable")
    body = (
      <PreviewState
        family={type.family}
        label={label}
        role="alert"
        title="Couldn’t read this file"
        sentence="ticketd can’t read its stored copy on this computer."
        action={
          <RetryActions onRetry={preview.retry} details={info.message ?? ""} />
        }
      />
    );
  else if (info?.status === "unsupported" && file?.size_bytes === 0)
    body = (
      <PreviewState
        family={type.family}
        label={label}
        title="Empty file"
        sentence="It has no content, so there’s nothing to show."
      />
    );
  else if (info?.pdf && file) {
    pdfShown = true;
    body = (
      <PdfStage
        workspace={preview.workspace}
        file={file}
        attempt={preview.attempt}
        onRetry={preview.retry}
        scrollerRef={scroller}
        keysRef={stageKeys}
      />
    );
  } else if (info?.html && file) {
    reportShown = true;
    body = (
      <HtmlStage
        workspace={preview.workspace}
        file={file}
        attempt={preview.attempt}
        onRetry={preview.retry}
      />
    );
  } else if (
    info?.text &&
    file &&
    !info.text.partial &&
    info.text.total_bytes <= SVG_LIMIT &&
    /\.svg$/i.test(file.original_filename)
  ) {
    // An SVG is a picture, drawn as an image (never as a document).
    pictureShown = true;
    body = (
      <SvgStage
        key={`${preview.workspace}/${file.id}/${preview.attempt}`}
        workspace={preview.workspace}
        file={file}
        attempt={preview.attempt}
        onRetry={preview.retry}
        onError={preview.mediaFailed}
        scrollerRef={scroller}
        keysRef={stageKeys}
      />
    );
  } else if (info?.text && file) {
    textShown = true;
    body = (
      <TextStage
        workspace={preview.workspace}
        file={file}
        scope={info.text}
        attempt={preview.attempt}
        onRetry={preview.retry}
        scrollerRef={scroller}
        keysRef={stageKeys}
        reachable={!stageRef}
      />
    );
  } else if (info?.text_excerpt)
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
      <PreviewState
        family={type.family}
        label={label}
        title="Too large to preview"
        sentence={
          // A picture within the file-size limit is held back by its pixels, not its bytes.
          type.family === "image" &&
          file?.size_bytes != null &&
          file.size_bytes <= PREVIEW_BYTES
            ? "Its picture has too many pixels to show here. Open it in its app to see it."
            : `${file?.size_bytes != null ? `It’s ${formatSize(file.size_bytes)}. ` : ""}Open it in its app to ${see}.`
        }
      />
    );
  else if (info)
    body = (
      <PreviewState
        family={type.family}
        label={label}
        title={
          type.family === "file"
            ? "No preview for this file"
            : `No preview for ${type.family === "archive" ? `${type.word}s` : `${type.word} files`}`
        }
        sentence={`Open it in its app to ${type.family === "archive" ? "see what’s inside" : see}.`}
      />
    );
  else if (error && !awaited)
    body = <FailureState failure={error} onRetry={preview.retry} />;
  else
    body = <PreviewLoading shape={type.family === "pdf" ? "page" : "block"} />;
  return (
    <div
      ref={stage}
      className="attachment-preview-stage"
      // The format showing in the stage (a PDF's or picture's zoom keys) hears the keys first.
      onKeyDown={(event) => stageKeys.current?.(event)}
      {...(stageRef && {
        tabIndex: -1,
        role: "group",
        "aria-label": [file?.display_name ?? "File", type.word, place]
          .filter(Boolean)
          .join(", "),
      })}
      data-report={reportShown ? "" : undefined}
      data-pdf={pdfShown ? "" : undefined}
      data-picture={pictureShown ? "" : undefined}
      data-text={textShown ? "" : undefined}
    >
      {notice}
      <div
        // Another file is another canvas: it fades in rather than swapping.
        key={place ? (file?.id ?? "") : undefined}
        className="attachment-preview-canvas"
        data-fading={fading ? "" : undefined}
      >
        {body}
      </div>
    </div>
  );
}

/** The facts under (or beside) the stage: storage, type, size, age, uses. */
function PreviewFacts({
  preview,
  onNavigate,
}: {
  preview: Preview;
  onNavigate: () => void;
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
        {info?.html && (
          <>
            <dt>Preview</dt>
            <dd>Read-only, offline · Scripts and network are off</dd>
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

type Origin = {
  /** What had focus when the viewer opened: the card or link that opened it. */
  focus: HTMLElement | null;
  /** Every scrolled ancestor of it, and the document, with their positions. */
  scroll: [Element, number][];
};

/**
 * macOS WebKit does not focus a button or link that is clicked: focus stays on
 * the body, or lands on the nearest focusable container. So the opener of a
 * mouse-opened viewer is what was last pressed, not what has focus.
 */
let pressed: { target: Element; at: number } | null = null;
if (typeof document !== "undefined")
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (event.target instanceof Element)
        pressed = { target: event.target, at: event.timeStamp };
    },
    true,
  );
const OPENER_MS = 5000;

/** What opened the viewer: what has focus, or the control just pressed that took none. */
function captureOpener(): HTMLElement | null {
  const active = document.activeElement;
  const focused =
    active instanceof HTMLElement && active !== document.body ? active : null;
  if (pressed && performance.now() - pressed.at < OPENER_MS) {
    const control = pressed.target.closest<HTMLElement>(
      "button, a[href], [role='button'], [tabindex]",
    );
    if (
      control?.isConnected &&
      (!focused || (focused !== control && focused.contains(control)))
    )
      return control;
  }
  return focused;
}

/** Reads where the reviewer is, so closing the viewer can put them back. */
function captureOrigin(): Origin {
  const focus = captureOpener();
  const scroll: [Element, number][] = [];
  for (let node: Element | null = focus; node; node = node.parentElement)
    if (node.scrollTop > 0) scroll.push([node, node.scrollTop]);
  const root = document.scrollingElement;
  if (root && root.scrollTop > 0) scroll.push([root, root.scrollTop]);
  return { focus, scroll };
}

function restoreScroll(scroll: [Element, number][]) {
  for (const [element, top] of scroll)
    if (element.isConnected && element.scrollTop !== top)
      element.scrollTop = top;
}

/** The files of the place the viewer was opened from, and the way to move among them. */
export type Browse = {
  /** In the order that place shows them. */
  files: Attachment[];
  /** The file that should now be shown; the caller changes the viewer's target. */
  onSelect: (file: Attachment) => void;
};

/** Reads the neighbors' previews ahead of a step, so the next file shows at once. */
function useReadAhead(
  ids: string[],
  ready: boolean,
  warm: Map<string, PreviewInfo>,
) {
  const key = ids.join("\n");
  useEffect(() => {
    if (!ready || !key) return;
    let active = true;
    void attachments
      .workspaceId()
      .then(async (workspace) => {
        for (const id of key.split("\n")) {
          if (!active || warm.has(id)) continue;
          // One neighbor that will not read does not stop the others.
          try {
            warm.set(id, await attachments.preview(workspace, id));
          } catch {
            // A step to it reads it again and shows why.
          }
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [key, ready, warm]);
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
  menuItems,
  notice,
  fallbackFocus,
  browse,
}: {
  target: PreviewTarget;
  onClose: () => void;
  /**
   * Previous and Next walk these files (J and K); with fewer than two, or when
   * the target is not one of them, there is nothing to walk.
   */
  browse?: Browse;
  onReplace?: ReferenceReplacement | undefined;
  /** Actions of the place that opened it, after a separator in "…" (Detach from ticket). */
  menuItems?: ReactNode;
  /** The last failure of one of those actions, shown above the stage. */
  notice?: ReactNode;
  /** Where focus goes on close when what opened the viewer is gone. */
  fallbackFocus?: () => HTMLElement | null;
}) {
  const [warm] = useState(() => new Map<string, PreviewInfo>());
  const preview = usePreview(target, warm);
  const presence = useDialogPresence(onClose);
  const [picking, setPicking] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [commands, setCommands] = useState<AttachmentPreviewCommands | null>(
    null,
  );
  const compact = useCompact();
  const { attachmentDetails: detailsShown } = usePreferences();
  const stage = useRef<HTMLDivElement>(null);
  // What the reviewer was looking at when the viewer opened, to put back on close.
  // It stays the opener while files are stepped through.
  const [origin] = useState(captureOrigin);
  const ids = browse?.files.map((entry) => entry.id) ?? [];
  const at = "id" in target ? ids.indexOf(target.id) : -1;
  const walking = browse !== undefined && ids.length > 1 && at >= 0;
  const [fading, setFading] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const step = (delta: -1 | 1) => {
    const next = browse?.files[at + delta];
    if (!browse || !walking || !next) return;
    setFading(true);
    setRenaming(false);
    setAnnouncement(
      `${next.display_name}, ${fileType(next.original_filename).word}, ${at + delta + 1} of ${ids.length}`,
    );
    browse.onSelect(next);
  };
  useReadAhead(
    walking ? [ids[at - 1], ids[at + 1]].filter((id) => id !== undefined) : [],
    preview.info !== null,
    warm,
  );
  const shownId = "id" in target ? target.id : "";
  // Each file opens at its top, and focus that has nowhere useful to stay goes to the stage.
  useLayoutEffect(() => {
    if (!fading) return;
    if (stage.current) stage.current.scrollTop = 0;
    const active = document.activeElement;
    // Focus on the viewer itself is what a click on Previous or Next leaves in
    // WebKit, which does not focus buttons: the reading keys should still work.
    if (
      active === document.body ||
      active === stage.current?.closest("[role='dialog']") ||
      (active instanceof HTMLButtonElement && active.disabled)
    )
      stage.current?.focus({ preventScroll: true });
  }, [shownId, fading]);
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
  const position: Position | undefined = walking
    ? { index: at + 1, total: ids.length, step }
    : undefined;
  const details = {
    shown: detailsShown,
    toggle: () => setPreference("attachmentDetails", !detailsShown),
  };
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
        // The opener, unless it is gone (the file was detached meanwhile).
        resolveReturnFocus={() =>
          origin.focus?.isConnected ? origin.focus : (fallbackFocus?.() ?? null)
        }
        onEscapeKeyDown={(event) => {
          // Renaming is a field too: Esc cancels it first. The dialog hears the key
          // before the form does, so it cancels here and keeps the viewer open.
          if (renaming) {
            event.preventDefault();
            setRenaming(false);
            return;
          }
          // In a field of the format (the PDF's page number), Esc leaves the field first.
          const field =
            event.target instanceof HTMLElement &&
            event.target.closest("[data-view-field]");
          if (!field) return;
          event.preventDefault();
          stage.current?.focus({ preventScroll: true });
        }}
        onOpenAutoFocus={(event) => {
          // The stage takes focus, so Space and the reading keys work at once.
          event.preventDefault();
          stage.current?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={() => {
          // Put the ticket back where it was, whichever file was shown last.
          const restore = () => restoreScroll(origin.scroll);
          restore();
          queueMicrotask(restore);
          if (!presence.dialog.open) presence.dialog.onExitComplete();
        }}
        onKeyDown={(event) => {
          if (
            event.target instanceof HTMLElement &&
            event.target.closest(
              "input, textarea, select, [contenteditable], [role='menu']",
            )
          )
            return;
          if (matchesShortcut(event, "attachments-details")) {
            event.preventDefault();
            details.toggle();
          } else if (matchesShortcut(event, "attachments-open")) {
            event.preventDefault();
            commands?.open?.();
          } else if (matchesShortcut(event, "attachments-more")) {
            event.preventDefault();
            commands?.more?.();
          } else if (walking && matchesShortcut(event, "attachments-next")) {
            // At the last file the key does nothing; it never wraps around.
            event.preventDefault();
            step(1);
          } else if (
            walking &&
            matchesShortcut(event, "attachments-previous")
          ) {
            event.preventDefault();
            step(-1);
          }
        }}
      >
        {/* The viewer is a dialog in a portal: it takes none of the shell's header controls. */}
        <ShellSlotProvider nav={null} crumb={null}>
          <div
            className="attachment-preview"
            data-layout="viewer"
            data-details={detailsShown ? "" : undefined}
          >
            <PreviewHeader
              preview={preview}
              title={(name) => <DialogTitle>{name}</DialogTitle>}
              onClose={close}
              close={(button) => <DialogClose asChild>{button}</DialogClose>}
              onReplace={replace}
              onChanged={undefined}
              menuItems={menuItems}
              renaming={renaming}
              onRenamingChange={setRenaming}
              details={details}
              compact={compact}
              position={position}
              onCommandsChange={setCommands}
            />
            <DialogDescription className="sr-only">
              {file
                ? `${fileType(file.original_filename).word} preview`
                : "Preview"}
            </DialogDescription>
            <div aria-live="polite" className="sr-only">
              {announcement}
            </div>
            <div className="attachment-preview-body">
              <div className="attachment-preview-main">
                {notice && (
                  <div className="attachment-preview-failure">{notice}</div>
                )}
                <PreviewFailure preview={preview} />
                <PreviewStage
                  preview={preview}
                  stageRef={stage}
                  place={position && `${position.index} of ${position.total}`}
                  fading={fading}
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
              </div>
              {detailsShown && (
                <aside
                  className="attachment-preview-details"
                  aria-label="Details"
                >
                  <PreviewFacts preview={preview} onNavigate={close} />
                </aside>
              )}
            </div>
          </div>
        </ShellSlotProvider>
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
        <PreviewFacts preview={preview} onNavigate={() => {}} />
        <PreviewFailure preview={preview} />
      </div>
    </section>
  );
}
