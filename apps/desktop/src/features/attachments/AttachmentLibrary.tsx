import { Fragment, useRef, useState } from "react";
import { ChevronRight, Paperclip, Plus, SearchX, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FailureAlert, FailureState } from "@/components/ui/failure-alert";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  attachments,
  type Attachment,
  type AttachmentState,
} from "@/lib/api/attachments";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { formatDateTime, relativeDateTime } from "@/lib/format";
import { AttachmentCleanup } from "./AttachmentCleanup";
import { PurgeAttachment } from "./PurgeAttachment";
import { RemoveRemoteAttachment } from "./RemoveRemoteAttachment";
import { AttachmentPicker } from "./AttachmentPicker";
import { useAttachmentSearch } from "./use-attachment-search";
import { formatSize } from "./format-size";
import { RenameAttachment } from "./RenameAttachment";
import { AttachmentThumbnail } from "./AttachmentThumbnail";
import "./attachment-library.css";
import { useAvailability } from "@/features/sync-review/availability";
import { StorageAvailability } from "@/features/sync-review/StorageAvailability";

export function AttachmentLibrary({
  onPreview,
  onOpenSettings,
}: {
  onPreview: (file: Attachment) => void;
  onOpenSettings?: () => void;
}) {
  const [search, setSearch] = useState("");
  const [state, setState] = useState<AttachmentState>("all");
  const [offset, setOffset] = useState(0);
  const [picker, setPicker] = useState(false);
  const [renaming, setRenaming] = useState<Attachment | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [cleanup, setCleanup] = useState(false);
  const [purging, setPurging] = useState<Attachment | null>(null);
  const [removing, setRemoving] = useState<Attachment | null>(null);
  const cleanupTrigger = useRef<HTMLButtonElement>(null);
  // A restore or download that failed shows under the row it concerns.
  const [rowFailure, setRowFailure] = useState<{
    id: string;
    failure: FailureDescription;
    retry: () => void;
  } | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const { files, loading, pending, error, answered } = useAttachmentSearch(
    search,
    state,
    null,
    offset,
    refresh,
  );
  // Nothing at all in the workspace: no table, paging or Clean up over it.
  const libraryEmpty =
    !loading &&
    !error &&
    files.length === 0 &&
    answered.search.trim() === "" &&
    answered.state === "all" &&
    answered.offset === 0;
  const onePage = answered.offset === 0 && files.length < 50;
  const addTrigger = useRef<HTMLButtonElement>(null);
  const availability = useAvailability(
    files
      .filter(({ attachment }) => attachment.kind === "local_snapshot")
      .map(({ attachment }) => attachment.id),
  );
  // Only when there is another page to move to.
  const pagination = (
    <footer>
      <div className="attachment-actions">
        <Button
          variant="ghost"
          disabled={offset === 0}
          onClick={() => setOffset(Math.max(0, offset - 50))}
        >
          Previous files
        </Button>
        <Button
          variant="ghost"
          disabled={files.length < 50}
          onClick={() => setOffset(offset + 50)}
        >
          Next files
        </Button>
      </div>
    </footer>
  );
  function restore(file: Attachment) {
    setRestoring(file.id);
    setRowFailure(null);
    void attachments
      .restore(file.id, crypto.randomUUID())
      .then(() => setRefresh((value) => value + 1))
      .catch((reason: unknown) =>
        setRowFailure({
          id: file.id,
          failure: describeFailure(reason, `restore ${file.display_name}`),
          retry: () => restore(file),
        }),
      )
      .finally(() => setRestoring(null));
  }
  function download(file: Attachment) {
    setRowFailure(null);
    availability.download(file.id).catch((reason: unknown) =>
      setRowFailure({
        id: file.id,
        failure: describeFailure(reason, `download ${file.display_name}`),
        retry: () => download(file),
      }),
    );
  }
  return (
    <div className="attachment-workspace">
      <div className="attachment-library-bar">
        <nav aria-label="Attachment location">
          <span>Workspace</span>
          <ChevronRight aria-hidden="true" />
          <span aria-current="page">Attachments</span>
        </nav>
        {onOpenSettings && (
          <Button variant="ghost" size="sm" onClick={onOpenSettings}>
            <Settings aria-hidden="true" />
            Storage settings
          </Button>
        )}
      </div>
      <section className="attachment-library" aria-label="Attachment library">
        <header>
          <div>
            <h1>Attachments</h1>
            <p>Files used across your tickets and Documents.</p>
          </div>
          <div className="attachment-actions">
            {!libraryEmpty && (
              <Button
                ref={cleanupTrigger}
                variant="outline"
                onClick={() => setCleanup(true)}
              >
                Clean up
              </Button>
            )}
            <Button ref={addTrigger} onClick={() => setPicker(true)}>
              <Plus aria-hidden="true" />
              Add files
            </Button>
          </div>
        </header>
        <div className="attachment-library-tools">
          <Input
            type="search"
            aria-label="Search files"
            placeholder="Search names and metadata…"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setOffset(0);
            }}
          />
          <SegmentedControl
            aria-label="File usage"
            value={state}
            onValueChange={(next) => {
              setState(next);
              setOffset(0);
            }}
            options={[
              { value: "all", label: "All files" },
              { value: "in_use", label: "In use" },
              { value: "unused", label: "Unused" },
              { value: "quarantined", label: "Quarantine" },
            ]}
          />
        </div>
        {error ? (
          <FailureState
            failure={error}
            onRetry={() => setRefresh((value) => value + 1)}
          />
        ) : loading ? (
          <p role="status">Loading files…</p>
        ) : libraryEmpty ? (
          <EmptyState
            icon={<Paperclip />}
            title="No attachments yet"
            description="Files you attach to tickets and Documents appear here."
          />
        ) : files.length === 0 ? (
          <>
            <NoFiles
              search={answered.search.trim()}
              state={answered.state}
              later={answered.offset > 0}
              onClearSearch={() => {
                setSearch("");
                setOffset(0);
              }}
              onShowAll={() => {
                setState("all");
                setOffset(0);
              }}
            />
            {!onePage && pagination}
          </>
        ) : (
          <>
            <div className="attachment-table-scroll" aria-busy={pending}>
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Storage</th>
                    <th>Size</th>
                    <th>Used in</th>
                    <th>Added</th>
                    <th>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {files.map(({ attachment: file, usage }) => (
                    <Fragment key={file.id}>
                      <tr>
                        <td>
                          <button
                            type="button"
                            className="attachment-row"
                            aria-label={file.display_name}
                            onClick={() => onPreview(file)}
                          >
                            <AttachmentThumbnail file={file} />
                            <span>
                              {file.display_name}
                              <small>{file.original_filename}</small>
                              {file.purge_state === "purged" ? (
                                <small>
                                  Permanently purged · Bytes unavailable
                                </small>
                              ) : file.purge_state === "pending" ? (
                                <small>
                                  Permanent purge pending · Bytes unavailable
                                </small>
                              ) : (
                                file.quarantined && <small>Quarantined</small>
                              )}
                            </span>
                          </button>
                        </td>
                        <td data-label="Storage">
                          {file.kind === "local_snapshot" ? (
                            <StorageAvailability
                              name={file.display_name}
                              availability={availability.of(file.id)}
                            />
                          ) : file.uploaded_copy ? (
                            "Uploaded copy"
                          ) : (
                            "External reference"
                          )}
                        </td>
                        <td data-label="Size">
                          {file.size_bytes === null
                            ? "—"
                            : formatSize(file.size_bytes)}
                        </td>
                        <td data-label="Used in">
                          <button
                            type="button"
                            className="attachment-usage-link"
                            onClick={() => onPreview(file)}
                          >
                            {usage.protections.length
                              ? `${usage.protections.length} ${usage.protections.length === 1 ? "place" : "places"}`
                              : usage.legacy_drafts_pending
                                ? "Recovery protected"
                                : "Unused"}
                          </button>
                        </td>
                        <td data-label="Added">
                          {file.added_at ? (
                            <time
                              dateTime={file.added_at}
                              title={formatDateTime(file.added_at)}
                            >
                              {relativeDateTime(file.added_at)}
                            </time>
                          ) : (
                            <span title="No registration date was recorded">
                              Unknown
                            </span>
                          )}
                        </td>
                        <td>
                          {file.kind === "external_reference" && (
                            <Button
                              variant="ghost"
                              aria-label={`Remove ${file.display_name} from ticketd`}
                              onClick={() => setRemoving(file)}
                            >
                              Remove from ticketd
                            </Button>
                          )}
                          {file.quarantined &&
                            file.purge_state !== "purged" &&
                            file.purge_state !== "pending" && (
                              <Button
                                variant="outline"
                                aria-label={`Restore ${file.display_name}`}
                                disabled={restoring !== null}
                                onClick={() => restore(file)}
                              >
                                Restore
                              </Button>
                            )}
                          {file.quarantined &&
                            file.purge_state !== "purged" && (
                              <Button
                                variant="ghost"
                                aria-label={`Permanently purge ${file.display_name}`}
                                onClick={() => setPurging(file)}
                              >
                                {file.purge_state === "pending"
                                  ? "Retry purge"
                                  : "Permanently purge"}
                              </Button>
                            )}
                          {availability.of(file.id)?.state ===
                            "not_downloaded" && (
                            <Button
                              variant="ghost"
                              aria-label={`Download ${file.display_name}`}
                              onClick={() => download(file)}
                            >
                              Download
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            aria-label={`Rename ${file.display_name}`}
                            onClick={() => setRenaming(file)}
                          >
                            Rename
                          </Button>
                        </td>
                      </tr>
                      {rowFailure?.id === file.id && (
                        <tr className="attachment-row-failure">
                          <td colSpan={6}>
                            <FailureAlert
                              size="compact"
                              failure={rowFailure.failure}
                              onRetry={rowFailure.retry}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
            {!onePage && pagination}
          </>
        )}
        <AttachmentPicker
          purpose="store"
          open={picker}
          onOpenChange={(open) => {
            setPicker(open);
            if (!open) setRefresh((value) => value + 1);
          }}
          onPick={async () => {
            setRefresh((value) => value + 1);
          }}
        />
        {renaming && (
          <RenameAttachment
            file={renaming}
            onClose={() => setRenaming(null)}
            onRenamed={() => setRefresh((value) => value + 1)}
          />
        )}
        {cleanup && (
          <AttachmentCleanup
            onClose={() => setCleanup(false)}
            onChanged={() => setRefresh((value) => value + 1)}
          />
        )}
        {purging && (
          <PurgeAttachment
            file={purging}
            onClose={() => setPurging(null)}
            onChanged={() => setRefresh((value) => value + 1)}
          />
        )}
        {removing && (
          <RemoveRemoteAttachment
            file={removing}
            onClose={() => setRemoving(null)}
            onChanged={() => setRefresh((value) => value + 1)}
            onRemovedFocus={() =>
              // Clean up is gone once the last file is.
              (cleanupTrigger.current ?? addTrigger.current)?.focus()
            }
          />
        )}
      </section>
    </div>
  );
}

const STATE_NAMES: Record<AttachmentState, string> = {
  all: "All files",
  in_use: "In use",
  unused: "Unused",
  quarantined: "Quarantine",
};

/** The library has files, but none answer this search, filter or page. */
function NoFiles({
  search,
  state,
  later,
  onClearSearch,
  onShowAll,
}: {
  search: string;
  state: AttachmentState;
  /** A page past the first came back empty. */
  later: boolean;
  onClearSearch: () => void;
  onShowAll: () => void;
}) {
  if (search)
    return (
      <EmptyState
        icon={<SearchX />}
        title={`No files match “${search}”`}
        description={`Searched names and metadata in ${STATE_NAMES[state]}.`}
        action={
          <Button variant="outline" size="sm" onClick={onClearSearch}>
            Clear search
          </Button>
        }
      />
    );
  if (later || state === "all") return <EmptyState title="No more files" />;
  const copy = {
    in_use: {
      title: "No files in use",
      description: "Files a ticket or Document links to appear here.",
    },
    unused: {
      title: "No unused files",
      description: "Files no ticket or Document links to appear here.",
    },
    quarantined: {
      title: "Quarantine is empty",
      description:
        "Files you clean up wait here until you restore or purge them.",
    },
  }[state];
  return (
    <EmptyState
      icon={<SearchX />}
      title={copy.title}
      description={copy.description}
      action={
        <Button variant="outline" size="sm" onClick={onShowAll}>
          Show all files
        </Button>
      }
    />
  );
}
