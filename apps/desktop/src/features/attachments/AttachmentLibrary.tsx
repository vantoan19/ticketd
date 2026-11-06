import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import type { Attachment, AttachmentState } from "@/lib/api/attachments";
import { AttachmentPicker } from "./AttachmentPicker";
import { useAttachmentSearch } from "./use-attachment-search";
import { formatSize } from "./format-size";
import { usageContext } from "./usage-context";
import { RenameAttachment } from "./RenameAttachment";
import { AttachmentThumbnail } from "./AttachmentThumbnail";
import "./attachment-library.css";

export function AttachmentLibrary({
  onPreview,
}: {
  onPreview: (file: Attachment) => void;
}) {
  const [search, setSearch] = useState("");
  const [state, setState] = useState<AttachmentState>("all");
  const [offset, setOffset] = useState(0);
  const [picker, setPicker] = useState(false);
  const [renaming, setRenaming] = useState<Attachment | null>(null);
  const [refresh, setRefresh] = useState(0);
  const { files, loading, error } = useAttachmentSearch(
    search,
    state,
    null,
    offset,
    refresh,
  );
  return (
    <section className="attachment-library" aria-label="Attachment library">
      <header>
        <div>
          <h1>Attachments</h1>
          <p>Files used across your tickets and Documents.</p>
        </div>
        <Button onClick={() => setPicker(true)}>
          <Plus aria-hidden="true" />
          Add files
        </Button>
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
          ]}
        />
      </div>
      {error && <p role="alert">{error}</p>}
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
                          : "Unused"}
                      </button>
                      <small>{usageContext(usage)}</small>
                    </td>
                    <td>
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
    </section>
  );
}
