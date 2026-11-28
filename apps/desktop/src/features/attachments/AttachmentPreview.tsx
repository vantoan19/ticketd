import {
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { FailureAlert } from "@/components/ui/failure-alert";
import { ShellSlotProvider } from "@/components/ui/list-header";
import { useDialogPresence } from "@/components/ui/use-dialog-presence";
import type { Attachment, PreviewInfo } from "@/lib/api/attachments";
import { setPreference, usePreferences } from "@/lib/preferences";
import { SettingsNavigation } from "@/lib/settings-navigation";
import { matchesShortcut } from "@/lib/shortcuts";
import { AttachmentPicker } from "./AttachmentPicker";
import { PreviewDetails } from "./PreviewDetails";
import { PreviewFacts } from "./PreviewFacts";
import {
  PreviewHeader,
  type AttachmentPreviewCommands,
  type Position,
} from "./PreviewHeader";
import { PreviewStage } from "./PreviewStage";
import { fileType } from "./file-words";
import {
  usePreview,
  useReadAhead,
  type Preview,
  type PreviewTarget,
} from "./use-attachment-preview";
import "./attachment-preview.css";

export type { AttachmentPreviewCommands } from "./PreviewHeader";
export type { PreviewTarget } from "./use-attachment-preview";

export type ReferenceReplacement = (
  file: Attachment,
  requestId: string,
  signal: AbortSignal,
) => Promise<void>;

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
  /** Every ancestor of it, and the document, with their positions (the top included). */
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
    scroll.push([node, node.scrollTop]);
  const root = document.scrollingElement;
  if (root) scroll.push([root, root.scrollTop]);
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
                          openSettings("backups-export");
                        }
                      : undefined
                  }
                  onChanged={undefined}
                />
              </div>
              {detailsShown && (
                <PreviewDetails preview={preview} onNavigate={close} />
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
            openSettings ? () => openSettings("backups-export") : undefined
          }
          onChanged={onChanged}
        />
        <PreviewFacts preview={preview} onNavigate={() => {}} />
        <PreviewFailure preview={preview} />
      </div>
    </section>
  );
}
