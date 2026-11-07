import { useState } from "react";
import { ChevronRight, Plus, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  attachments,
  type Attachment,
  type AttachmentState,
} from "@/lib/api/attachments";
import { formatDateTime, relativeDateTime } from "@/lib/format";
import { AttachmentCleanup } from "./AttachmentCleanup";
import { AttachmentPicker } from "./AttachmentPicker";
import { useAttachmentSearch } from "./use-attachment-search";
import { formatSize } from "./format-size";
import { RenameAttachment } from "./RenameAttachment";
import { AttachmentThumbnail } from "./AttachmentThumbnail";
import "./attachment-library.css";

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
  const [restoreError, setRestoreError] = useState("");
  const [restoring, setRestoring] = useState<string | null>(null);
  const { files, loading, error } = useAttachmentSearch(
    search,
    state,
    null,
    offset,
    refresh,
  );
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
            <Button variant="outline" onClick={() => setCleanup(true)}>
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
        {error && <p role="alert">{error}</p>}
        {restoreError && <p role="alert">{restoreError}</p>}
        {loading ? (
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
                    <tr key={file.id}>
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
                            {file.quarantined && <small>Quarantined</small>}
                          </span>
                        </button>
                      </td>
                      <td>
                        {file.kind === "local_snapshot"
                          ? "Local snapshot"
                          : "External reference"}
                      </td>
                      <td>
                        {file.size_bytes === null
                          ? "—"
                          : formatSize(file.size_bytes)}
                      </td>
                      <td>
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
                      <td>
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
                        {file.quarantined && (
                          <Button
                            variant="outline"
                            aria-label={`Restore ${file.display_name}`}
                            disabled={restoring !== null}
                            onClick={() => {
                              setRestoring(file.id);
                              setRestoreError("");
                              void attachments
                                .restore(file.id, crypto.randomUUID())
                                .then(() => setRefresh((value) => value + 1))
                                .catch((reason: unknown) =>
                                  setRestoreError(String(reason)),
                                )
                                .finally(() => setRestoring(null));
                            }}
                          >
                            Restore
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
      </section>
    </div>
  );
}
