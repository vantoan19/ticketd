import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  CloudDownload,
  Download,
  Ellipsis,
  Link,
  PanelRight,
  Pencil,
  RefreshCw,
  RotateCcw,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { Kbd } from "@/components/ui/kbd";
import { PaneHeader } from "@/components/ui/list-header";
import { Tooltip } from "@/components/ui/tooltip";
import { useCopy } from "@/components/ui/use-copy";
import { useStatusLine } from "@/components/ui/use-status-line";
import { attachments, type Attachment } from "@/lib/api/attachments";
import { ariaKeyShortcuts, shortcutLabel } from "@/lib/shortcuts";
import { FileIcon } from "./AttachmentThumbnail";
import { ExportMarkdownButton } from "./ExportMarkdown";
import { FittedTitle } from "./FittedTitle";
import { RenameAttachment } from "./RenameAttachment";
import { fileType } from "./file-words";
import type { Preview } from "./use-attachment-preview";

export type AttachmentPreviewCommands = {
  open: (() => void) | null;
  more: (() => void) | null;
};

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
export type Position = {
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
export function PreviewHeader({
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
            message: "Couldn’t copy the link.",
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
            label="Back to Files"
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
                          preview.retryIfShown(file.id);
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
