import { useContext, useRef, useState, type KeyboardEvent } from "react";
import {
  Ellipsis,
  ListFilter,
  Paperclip,
  Plus,
  Search,
  SearchX,
  X,
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
import { FailureState } from "@/components/ui/failure-alert";
import { IconButton } from "@/components/ui/icon-button";
import { PaneHeader, PaneHeaderButton } from "@/components/ui/list-header";
import { Pager } from "@/components/ui/pager";
import { Progress } from "@/components/ui/progress";
import { SearchInput } from "@/components/ui/search-input";
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
export function AttachmentLibrary() {
  return (
    <div className="attachment-library-host">
      <StatusLineRegion>
        <Library />
      </StatusLineRegion>
    </div>
  );
}

function Library() {
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
  const changed = () => setRefresh((value) => value + 1);
  const { files, loading, pending, error, answered, more } =
    useAttachmentSearch(search, state, null, limit, refresh);
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
  function focusRow(index: number) {
    const rows = list.current?.querySelectorAll<HTMLButtonElement>(
      "[data-slot='attachment-row']",
    );
    const row = rows?.[Math.max(0, Math.min(index, (rows?.length ?? 1) - 1))];
    row?.focus();
    row?.click();
  }
  function onListKey(event: KeyboardEvent<HTMLUListElement>) {
    const rows = Array.from(
      list.current?.querySelectorAll<HTMLButtonElement>(
        "[data-slot='attachment-row']",
      ) ?? [],
    );
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    const next =
      event.key === "ArrowDown" || event.key === "j"
        ? at + 1
        : event.key === "ArrowUp" || event.key === "k"
          ? at - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? rows.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    focusRow(next);
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
        !loading && { count: <Count>{files.length}</Count> })}
      actions={
        <>
          {!libraryEmpty &&
            (searching || search ? (
              <span
                data-slot="pane-search"
                role="search"
                className="attachment-search"
              >
                <SearchInput
                  fill
                  autoFocus
                  aria-label="Search files"
                  placeholder="Search files…"
                  value={search}
                  onValueChange={(value) => {
                    setSearch(value);
                    setLimit(ATTACHMENT_PAGE);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.stopPropagation();
                      setSearching(false);
                    }
                  }}
                />
                <IconButton
                  label="Close search"
                  onClick={() => {
                    setSearch("");
                    setSearching(false);
                  }}
                >
                  <X />
                </IconButton>
              </span>
            ) : (
              <IconButton
                label="Search files"
                onClick={() => setSearching(true)}
              >
                <Search />
              </IconButton>
            ))}
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
          <Button
            ref={addTrigger}
            variant="outline"
            size="sm"
            className="ml-1"
            onClick={() => setPicker(true)}
          >
            <Plus aria-hidden="true" />
            Add files
          </Button>
        </>
      }
    />
  );
  let body;
  if (error) body = <FailureState failure={error} onRetry={changed} />;
  else if (loading) body = null;
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
      files.find(({ attachment }) => attachment.id === selected?.id)?.attachment
        .id ?? files[0]?.attachment.id;
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
    >
      <section className="attachment-list-pane" aria-label="Attachments">
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
        <div className="attachment-list-scroll">{body}</div>
      </section>
      {!libraryEmpty && (
        <section className="attachment-detail-pane" aria-label="File preview">
          {selected ? (
            <AttachmentPreviewPane
              key={selected.id}
              file={selected}
              renameRequest={renameRequest}
              onClose={() => {
                const id = selected.id;
                setSelected(null);
                list.current
                  ?.querySelector<HTMLButtonElement>(
                    `[data-slot='attachment-row'][data-id='${CSS.escape(id)}']`,
                  )
                  ?.focus();
              }}
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
  menu,
}: {
  row: AttachmentSearchResult;
  availability: Availability | undefined;
  /** Until the desktop's copies are known, a file in Drive is not called missing. */
  availabilityKnown: boolean;
  open: boolean;
  tabbable: boolean;
  onOpen: () => void;
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
    age,
  ]
    .filter(Boolean)
    .join(" · ");
  const captionId = `attachment-row-${file.id}`;
  return (
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
      >
        <AttachmentThumbnail file={file} size="row" />
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
