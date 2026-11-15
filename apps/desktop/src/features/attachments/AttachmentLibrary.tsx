import { Fragment, useRef, useState } from "react";
import { ChevronRight, Plus, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
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
  const { files, loading, error } = useAttachmentSearch(
    search,
    state,
    null,
    offset,
    refresh,
  );
  const availability = useAvailability(
    files
      .filter(({ attachment }) => attachment.kind === "local_snapshot")
      .map(({ attachment }) => attachment.id),
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
            <Button
              ref={cleanupTrigger}
              variant="outline"
              onClick={() => setCleanup(true)}
            >
              Clean up
            </Button>
            <Button onClick={() => setPicker(true)}>
              <Plus aria-hidden="true" />
              Add files
            </Button>
          </div>
        </header>
        <div className="attachment-library-tools">
          <Input
            type="search"
            aria-label="Search files"
            placeholder="Search files…"
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
        ) : (
          <>
            <div className="attachment-table-scroll">
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
            {!files.length && <p>No matching files</p>}
            <footer>
              <span>Search covers filenames and available metadata</span>
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
            onRemovedFocus={() => cleanupTrigger.current?.focus()}
          />
        )}
      </section>
    </div>
  );
}
