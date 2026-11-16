import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  Ellipsis,
  ListFilter,
  Paperclip,
  Plus,
  Search,
  SearchX,
  UploadCloud,
} from "lucide-react";
import { Badge, FilterChip } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Count } from "@/components/ui/count";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { FailureAlert, FailureState } from "@/components/ui/failure-alert";
import { IconButton } from "@/components/ui/icon-button";
import { PaneHeader, PaneHeaderButton } from "@/components/ui/list-header";
import { Pager } from "@/components/ui/pager";
import { Progress } from "@/components/ui/progress";
import { NavigatorSearch } from "@/components/ui/navigator";
import { focusNavigatorRow } from "@/lib/navigator";
import { Item } from "@/components/ui/item";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  ariaKeyShortcuts,
  matchesShortcut,
  shortcutLabel,
} from "@/lib/shortcuts";
import type { AttachmentPreviewCommands } from "./AttachmentPreview";
import { StatusLabel } from "@/components/ui/status-label";
import { StatusLineRegion } from "@/components/ui/status-line";
import { useStatusLine } from "@/components/ui/use-status-line";
import { emptyCopy } from "@/lib/empty-copy";
import { compactAgo } from "@/lib/format";
import { SettingsNavigation } from "@/lib/settings-navigation";
import {
  attachments,
  type Attachment,
  type AttachmentSearchResult,
  type AttachmentState,
} from "@/lib/api/attachments";
import { describeFailure } from "@/lib/api/describe-failure";
import type { Availability } from "@/lib/sync-review-api";
import { useAvailability } from "@/features/sync-review/availability";
import { AttachmentCleanup } from "./AttachmentCleanup";
import { AttachmentPicker } from "./AttachmentPicker";
import { AttachmentPreviewPane } from "./AttachmentPreview";
import { AttachmentThumbnail } from "./AttachmentThumbnail";
import { PurgeAttachment } from "./PurgeAttachment";
import { RemoveRemoteAttachment } from "./RemoveRemoteAttachment";
import { fileType, purged, stateWord, usageWord } from "./file-words";
import { formatSize } from "./format-size";
import { ATTACHMENT_PAGE, useAttachmentSearch } from "./use-attachment-search";
import "./attachment-library.css";

const STATE_NAMES: Record<AttachmentState, string> = {
  all: "All files",
  in_use: "In use",
  unused: "Unused",
  quarantined: "Quarantined",
};

/**
 * The Attachments library: files work like tickets, a list and a preview
 * (S17). The list pane has a 48px header (title, count, Search, Filters, "…",
 * Add files) and two-line rows (name; "PNG image · 2.1 KB · Used in 1 · 4h")
 * with a state word where needed and one "…" revealed on hover. The chosen
 * file opens in the detail pane beside it. Outcomes go to the status line.
 */
export type AttachmentCommands = {
  search: (() => void) | null;
  add: (() => void) | null;
  open: (() => void) | null;
  more: (() => void) | null;
  back: (() => void) | null;
};
export function AttachmentLibrary({
  onCommandsChange,
}: {
  onCommandsChange?: (commands: AttachmentCommands | null) => void;
}) {
  return (
    <div className="attachment-library-host">
      <StatusLineRegion>
        <Library onCommandsChange={onCommandsChange} />
      </StatusLineRegion>
    </div>
  );
}

function Library({
  onCommandsChange,
}: {
  onCommandsChange: ((commands: AttachmentCommands | null) => void) | undefined;
}) {
  const statusLine = useStatusLine();
  const openSettings = useContext(SettingsNavigation);
  const [search, setSearch] = useState("");
  const [searching, setSearching] = useState(false);
  const [state, setState] = useState<AttachmentState>("all");
  const [limit, setLimit] = useState(ATTACHMENT_PAGE);
  const [picker, setPicker] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [cleanup, setCleanup] = useState(false);
  const [purging, setPurging] = useState<Attachment | null>(null);
  const [removing, setRemoving] = useState<Attachment | null>(null);
  const [selected, setSelected] = useState<Attachment | null>(null);
  const [renameRequest, setRenameRequest] = useState(0);
  const addTrigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const searchTrigger = useRef<HTMLButtonElement>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [previewCommands, setPreviewCommands] =
    useState<AttachmentPreviewCommands | null>(null);
  const returnRow = useRef<string | null>(null);
  const closePreview = useCallback(() => {
    if (!selected) return;
    returnRow.current = selected.id;
    setSelected(null);
  }, [selected]);
  useLayoutEffect(() => {
    if (selected || !returnRow.current) return;
    const id = returnRow.current;
    returnRow.current = null;
    const rows = [
      ...(list.current?.querySelectorAll<HTMLButtonElement>(
        "[data-slot='attachment-row']",
      ) ?? []),
    ];
    (
      rows.find((row) => row.dataset.id === id) ?? searchTrigger.current
    )?.focus();
  }, [selected]);
  const closeSearch = () => {
    setSearch("");
    setSearching(false);
    requestAnimationFrame(() => searchTrigger.current?.focus());
  };
  const commands = useMemo<AttachmentCommands>(
    () => ({
      search: () => setSearching(true),
      add: () => setPicker(true),
      open: previewCommands?.open ?? null,
      more: previewCommands?.more ?? null,
      back: selected ? closePreview : null,
    }),
    [previewCommands, selected, closePreview],
  );
  useEffect(() => {
    onCommandsChange?.(commands);
    return () => onCommandsChange?.(null);
  }, [commands, onCommandsChange]);
  const [hovered, setHovered] = useState(false);
  const [listFocused, setListFocused] = useState(false);
  const changed = () => setRefresh((value) => value + 1);
  const { files, loading, pending, error, answered, more, known } =
    useAttachmentSearch(
      search,
      state,
      null,
      limit,
      refresh,
      hovered || listFocused,
    );
  // Nothing at all in the workspace: no search, filters, Clean up or preview.
  const libraryEmpty =
    !loading &&
    !error &&
    files.length === 0 &&
    answered.search.trim() === "" &&
    answered.state === "all";
  const availability = useAvailability(
    files
      .filter(({ attachment }) => attachment.kind === "local_snapshot")
      .map(({ attachment }) => attachment.id),
  );
  function restore(file: Attachment) {
    void attachments
      .restore(file.id, crypto.randomUUID())
      .then(() => {
        changed();
        statusLine.show({
          message: `Restored ${file.display_name}`,
          undo: async () => {
            await attachments.quarantine(file.id, crypto.randomUUID());
            changed();
          },
        });
      })
      .catch((reason: unknown) => {
        const failure = describeFailure(reason, `restore ${file.display_name}`);
        statusLine.show({
          tone: "error",
          message: `${failure.title}. ${failure.sentence}`,
          details: failure.details,
          ...(failure.action === "retry" && {
            action: { label: "Retry", run: () => restore(file) },
          }),
        });
      });
  }
  function download(file: Attachment) {
    availability.download(file.id).catch((reason: unknown) => {
      const failure = describeFailure(reason, `download ${file.display_name}`);
      statusLine.show({
        tone: "error",
        message: `${failure.title}. ${failure.sentence}`,
        details: failure.details,
        ...(failure.action === "retry" && {
          action: { label: "Retry", run: () => download(file) },
        }),
      });
    });
  }
  /** The library's own actions on a file, for its row menu and the preview's "…". */
  function fileActions(file: Attachment, inPreview: boolean) {
    const quarantined =
      Boolean(file.quarantined) && file.purge_state !== "purged";
    return (
      <>
        {!inPreview && (
          <>
            <DropdownMenuItem onSelect={() => setSelected(file)}>
              Open
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                setSelected(file);
                setRenameRequest((value) => value + 1);
              }}
            >
              Rename…
            </DropdownMenuItem>
            {availability.of(file.id)?.state === "not_downloaded" && (
              <DropdownMenuItem onSelect={() => download(file)}>
                Download
              </DropdownMenuItem>
            )}
            {quarantined && !purged(file) && (
              <DropdownMenuItem onSelect={() => restore(file)}>
                Restore
              </DropdownMenuItem>
            )}
          </>
        )}
        {file.kind === "external_reference" && (
          <DropdownMenuItem onSelect={() => setRemoving(file)}>
            Remove from ticketd…
          </DropdownMenuItem>
        )}
        {quarantined && (
          <>
            {!inPreview && <DropdownMenuSeparator />}
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => setPurging(file)}
            >
              {file.purge_state === "pending"
                ? "Finish deleting…"
                : "Delete permanently…"}
            </DropdownMenuItem>
          </>
        )}
      </>
    );
  }
  function onListKey(event: KeyboardEvent<HTMLUListElement>) {
    if (!matchesShortcut(event, "attachments-move")) return;
    const rows = Array.from(
      list.current?.querySelectorAll<HTMLButtonElement>(
        "[data-slot='attachment-row']",
      ) ?? [],
    );
    if (!rows.includes(document.activeElement as HTMLButtonElement)) return;
    event.preventDefault();
    event.stopPropagation();
    focusNavigatorRow(rows, document.activeElement, event.key);
  }
  const query = answered.search.trim();
  const showAll = () => {
    setState("all");
    setLimit(ATTACHMENT_PAGE);
  };
  const header = (
    <PaneHeader
      title="Attachments"
      {...(!libraryEmpty &&
        !query &&
        state === "all" &&
        !more &&
        known && { count: <Count>{files.length}</Count> })}
      titleEditor={
        searching ? (
          <NavigatorSearch
            aria-label="Search files"
            placeholder="Search files…"
            value={search}
            onValueChange={(value) => {
              setSearch(value);
              setLimit(ATTACHMENT_PAGE);
            }}
          />
        ) : undefined
      }
      actions={
        <>
          {!libraryEmpty && !searching && (
            <IconButton
              ref={searchTrigger}
              label="Search files"
              shortcut={shortcutLabel("attachments-search")}
              aria-keyshortcuts={ariaKeyShortcuts("attachments-search")}
              onClick={() => setSearching(true)}
            >
              <Search />
            </IconButton>
          )}
          {!libraryEmpty && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <PaneHeaderButton
                  icon={<ListFilter aria-hidden="true" />}
                  label="Filters"
                />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuRadioGroup
                  value={state}
                  onValueChange={(next) => {
                    setState(next as AttachmentState);
                    setLimit(ATTACHMENT_PAGE);
                  }}
                >
                  {(Object.keys(STATE_NAMES) as AttachmentState[]).map(
                    (value) => (
                      <DropdownMenuRadioItem key={value} value={value}>
                        {STATE_NAMES[value]}
                      </DropdownMenuRadioItem>
                    ),
                  )}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {(!libraryEmpty || openSettings) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton label="More library actions">
                  <Ellipsis />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {!libraryEmpty && (
                  <DropdownMenuItem onSelect={() => setCleanup(true)}>
                    Clean up unused files…
                  </DropdownMenuItem>
                )}
                {openSettings && (
                  <DropdownMenuItem
                    onSelect={() => openSettings("attachments")}
                  >
                    Storage settings
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <IconButton
            label="Add files"
            shortcut={shortcutLabel("attachments-add")}
            ref={addTrigger}
            className="ml-1"
            aria-keyshortcuts={ariaKeyShortcuts("attachments-add")}
            onClick={() => setPicker(true)}
          >
            <Plus aria-hidden="true" />
          </IconButton>
        </>
      }
    />
  );
  let body;
  if (error && !known)
    body = <FailureState failure={error} onRetry={changed} />;
  else if (loading)
    body = (
      <EmptyState size="inline" role="status" description="Loading files…" />
    );
  else if (libraryEmpty)
    body = (
      <EmptyState
        icon={<Paperclip />}
        title={emptyCopy("attachments").title}
        description={emptyCopy("attachments").sentence}
      />
    );
  else if (!files.length)
    body = (
      <NoFiles
        search={query}
        state={answered.state}
        onClearSearch={() => {
          setSearch("");
          setSearching(false);
        }}
        onShowAll={showAll}
      />
    );
  else {
    const focusable =
      files.find(
        ({ attachment }) => attachment.id === (focused ?? selected?.id),
      )?.attachment.id ?? files[0]?.attachment.id;
    body = (
      <>
        <ul
          ref={list}
          className="attachment-rows"
          aria-label="Files"
          aria-busy={pending}
          onKeyDown={onListKey}
        >
          {files.map((row) => (
            <FileRow
              key={row.attachment.id}
              row={row}
              availability={availability.of(row.attachment.id)}
              availabilityKnown={availability.known}
              open={selected?.id === row.attachment.id}
              tabbable={focusable === row.attachment.id}
              onFocus={() => setFocused(row.attachment.id)}
              onOpen={() => setSelected(row.attachment)}
              menu={fileActions(row.attachment, false)}
            />
          ))}
        </ul>
        {more && (
          <Pager
            more={ATTACHMENT_PAGE}
            noun="files"
            loading={pending}
            onMore={() => setLimit((value) => value + ATTACHMENT_PAGE)}
          />
        )}
      </>
    );
  }
  return (
    <div
      className="attachment-workspace"
      data-open={selected ? "" : undefined}
      data-empty={libraryEmpty ? "" : undefined}
      onKeyDownCapture={(event) => {
        if (
          event.key === "Escape" &&
          searching &&
          !(
            event.target instanceof HTMLElement &&
            event.target.closest("[role='dialog'], [role='menu']")
          )
        ) {
          event.preventDefault();
          event.stopPropagation();
          closeSearch();
        }
      }}
      onKeyDown={(event) => {
        if (
          event.target instanceof HTMLElement &&
          event.target.closest("[role='dialog'], [role='menu']")
        )
          return;
        if (event.key === "Escape" && searching) {
          event.preventDefault();
          event.stopPropagation();
          closeSearch();
          return;
        }
        if (
          event.target instanceof HTMLElement &&
          event.target.closest("input, textarea, [contenteditable]")
        )
          return;
        if (matchesShortcut(event, "attachments-search")) {
          event.preventDefault();
          event.stopPropagation();
          setSearching(true);
        } else if (matchesShortcut(event, "attachments-add")) {
          event.preventDefault();
          setPicker(true);
        } else if (event.key === "Escape" && selected) {
          event.preventDefault();
          event.stopPropagation();
          closePreview();
        }
      }}
    >
      <section
        className="attachment-list-pane"
        aria-label="Attachments"
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        onFocusCapture={() => setListFocused(true)}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget))
            setListFocused(false);
        }}
      >
        {header}
        {state !== "all" && !libraryEmpty && (
          <div className="attachment-chip-row">
            <FilterChip
              dimension="Show"
              value={STATE_NAMES[state]}
              removeLabel={`Remove filter ${STATE_NAMES[state]}`}
              onRemove={showAll}
            />
          </div>
        )}
        <div className="attachment-list-scroll">
          {error && known && (
            <FailureAlert failure={error} onRetry={changed} size="compact" />
          )}
          {body}
          {!loading && !error && !libraryEmpty && (
            <div className="attachment-drop-hint">
              <Alert role="note" presentation="hint">
                <UploadCloud aria-hidden="true" />
                <AlertDescription>
                  Drop files anywhere on a ticket or Document to attach them.
                  They are kept on this computer.
                </AlertDescription>
              </Alert>
            </div>
          )}
        </div>
      </section>
      {!libraryEmpty && (
        <section className="attachment-detail-pane" aria-label="File preview">
          {selected ? (
            <AttachmentPreviewPane
              key={selected.id}
              file={selected}
              renameRequest={renameRequest}
              onClose={closePreview}
              onCommandsChange={setPreviewCommands}
              onChanged={changed}
              menuItems={fileActions(selected, true)}
            />
          ) : (
            files.length > 0 && (
              <EmptyState
                size="hint"
                className="flex-1"
                title={emptyCopy("attachments-select").title}
              />
            )
          )}
        </section>
      )}
      <AttachmentPicker
        purpose="store"
        open={picker}
        onOpenChange={(open) => {
          setPicker(open);
          if (!open) changed();
        }}
        onPick={async () => {
          changed();
        }}
      />
      {cleanup && (
        <AttachmentCleanup
          onClose={() => setCleanup(false)}
          onChanged={changed}
          onMoved={(moved) =>
            statusLine.show({
              message:
                moved.length === 1
                  ? `Moved ${moved[0]?.display_name ?? "1 file"} to quarantine`
                  : `Moved ${moved.length} files to quarantine`,
              undo: async () => {
                for (const file of moved)
                  await attachments.restore(file.id, crypto.randomUUID());
                changed();
              },
            })
          }
        />
      )}
      {purging && (
        <PurgeAttachment
          file={purging}
          onClose={() => setPurging(null)}
          onChanged={changed}
          onPurged={() => {
            statusLine.show({
              message: `Deleted ${purging.display_name} permanently`,
            });
            if (selected?.id === purging.id) setSelected(null);
          }}
        />
      )}
      {removing && (
        <RemoveRemoteAttachment
          file={removing}
          onClose={() => setRemoving(null)}
          onChanged={() => {
            changed();
            if (selected?.id === removing.id) setSelected(null);
          }}
          onRemovedFocus={() => addTrigger.current?.focus()}
        />
      )}
    </div>
  );
}

/**
 * One file: a 24px thumbnail, the name, and one caption ("PNG image · 2.1 KB
 * · Used in 1 · 4h") led by a state word where one applies (Quarantined,
 * Missing, Not downloaded). The row opens the preview; its "…" is revealed on
 * hover, focus and the open row.
 */
function FileRow({
  row,
  availability,
  availabilityKnown,
  open,
  tabbable,
  onOpen,
  onFocus,
  menu,
}: {
  row: AttachmentSearchResult;
  availability: Availability | undefined;
  /** Until the desktop's copies are known, a file in Drive is not called missing. */
  availabilityKnown: boolean;
  open: boolean;
  tabbable: boolean;
  onOpen: () => void;
  onFocus: () => void;
  menu: React.ReactNode;
}) {
  const { attachment: file, usage } = row;
  const downloading = availability?.state === "downloading";
  const notDownloaded = availability?.state === "not_downloaded";
  const missing =
    Boolean(row.missing) && availabilityKnown && !notDownloaded && !downloading;
  const state = stateWord(file, missing);
  const storage =
    file.kind === "external_reference"
      ? file.uploaded_copy
        ? "Uploaded copy"
        : "Google Drive"
      : notDownloaded
        ? "Not downloaded"
        : null;
  const age = file.added_at ? compactAgo(file.added_at) : null;
  const caption = [
    fileType(file.original_filename).word,
    file.size_bytes !== null && formatSize(file.size_bytes),
    usageWord(usage),
    storage,
  ]
    .filter(Boolean)
    .join(" · ");
  const captionId = `attachment-row-${file.id}`;
  return (
    <Item asChild variant="navigator">
      <li className="attachment-mrow" data-open={open || undefined}>
        <button
          type="button"
          data-slot="attachment-row"
          data-id={file.id}
          className="attachment-mrow-main"
          aria-label={file.display_name}
          aria-describedby={captionId}
          aria-current={open || undefined}
          tabIndex={tabbable ? 0 : -1}
          onClick={onOpen}
          onFocus={onFocus}
          aria-keyshortcuts={ariaKeyShortcuts("attachments-move") + " Enter"}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onOpen();
            }
          }}
        >
          <AttachmentThumbnail file={file} size="navigator" />
          <span className="attachment-mrow-text">
            <span className="attachment-mrow-name">{file.display_name}</span>
            <span className="attachment-mrow-caption" id={captionId}>
              {state === "Missing" ? (
                <StatusLabel tone="attention" size="caption">
                  Missing
                </StatusLabel>
              ) : (
                state && <Badge size="sm">{state}</Badge>
              )}
              {downloading && (
                <Progress
                  aria-label={`Downloading ${file.display_name}`}
                  value={availability.progress ?? 0}
                />
              )}
              <span className="attachment-mrow-caption-text">
                {downloading ? "Downloading…" : caption}
              </span>
            </span>
          </span>
          <span className="attachment-mrow-time">{age}</span>
        </button>
        <span className="attachment-mrow-actions">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton
                label={`More actions for ${file.display_name}`}
                tooltipSide="top"
              >
                <Ellipsis />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">{menu}</DropdownMenuContent>
          </DropdownMenu>
        </span>
      </li>
    </Item>
  );
}

/** The library has files, but none answer this search or filter. */
function NoFiles({
  search,
  state,
  onClearSearch,
  onShowAll,
}: {
  search: string;
  state: AttachmentState;
  onClearSearch: () => void;
  onShowAll: () => void;
}) {
  if (search) {
    const copy = emptyCopy("attachments-search", {
      query: search,
      name: STATE_NAMES[state],
    });
    return (
      <EmptyState
        icon={<SearchX />}
        title={copy.title}
        description={copy.sentence}
        action={
          <Button variant="outline" size="sm" onClick={onClearSearch}>
            {copy.action}
          </Button>
        }
      />
    );
  }
  const copy = emptyCopy(
    state === "in_use"
      ? "attachments-in-use"
      : state === "unused"
        ? "attachments-unused"
        : "attachments-quarantine",
  );
  return (
    <EmptyState
      icon={<SearchX />}
      title={copy.title}
      description={copy.sentence}
      action={
        <Button variant="outline" size="sm" onClick={onShowAll}>
          {copy.action}
        </Button>
      }
    />
  );
}
