import { useEffect, useId, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import type { Attachment } from "@/lib/api/attachments";
import { useAttachmentSearch } from "./use-attachment-search";
import { formatSize } from "./format-size";
import { usageContext } from "./usage-context";
import { AttachmentThumbnail } from "./AttachmentThumbnail";

export function ExistingAttachments({
  ticketReference,
  onPick,
  onDone,
  onBusyChange,
  single = false,
}: {
  ticketReference: string | null;
  onPick: (file: Attachment, requestId: string) => Promise<void>;
  onDone: () => void;
  onBusyChange: (busy: boolean) => void;
  single?: boolean;
}) {
  const choiceName = useId();
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<
    { file: Attachment; requestId: string }[]
  >([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const current = useRef(true);
  useEffect(() => {
    current.current = true;
    return () => {
      current.current = false;
    };
  }, []);
  const { files, loading, error } = useAttachmentSearch(
    search,
    "all",
    ticketReference,
    offset,
  );
  async function insert() {
    if (single && selected.length !== 1) {
      setFailure("Choose one file to replace this reference.");
      return;
    }
    setBusy(true);
    onBusyChange(true);
    setFailure("");
    try {
      for (const item of selected) {
        if (!current.current) return;
        await onPick(item.file, item.requestId);
        if (!current.current) return;
        setSelected((rows) =>
          rows.filter((row) => row.file.id !== item.file.id),
        );
      }
      onDone();
    } catch (reason) {
      if (current.current) setFailure(String(reason));
    } finally {
      if (current.current) setBusy(false);
      onBusyChange(false);
    }
  }
  return (
    <div className="attachment-existing">
      <Input
        type="search"
        aria-label="Search existing files"
        placeholder="Search filenames or metadata…"
        disabled={busy}
        value={search}
        onChange={(event) => {
          setSearch(event.target.value);
          setOffset(0);
        }}
      />
      {loading && <p role="status">Loading files…</p>}
      <div
        className="attachment-existing-results"
        role={single ? "radiogroup" : undefined}
        aria-label={single ? "Existing file choice" : undefined}
      >
        {[true, false].map((related) => {
          const group = files.filter((row) => row.related === related);
          return (
            group.length > 0 && (
              <section
                key={String(related)}
                aria-label={
                  related ? "Related to this ticket" : "Recent in workspace"
                }
              >
                <p className="attachment-hint">
                  {related ? "Related to this ticket" : "Recent in workspace"}
                </p>
                <ul>
                  {group.map(({ attachment: file, usage }) => (
                    <li key={file.id}>
                      <label className="attachment-row">
                        <AttachmentThumbnail file={file} />
                        <span>
                          {file.display_name}
                          <small>
                            {file.size_bytes !== null && (
                              <>{formatSize(file.size_bytes)} · </>
                            )}
                            {usageContext(usage)}
                            {file.purge_state === "purged"
                              ? " · Permanently purged · Bytes unavailable"
                              : file.purge_state === "pending"
                                ? " · Permanent purge pending · Bytes unavailable"
                                : ""}
                          </small>
                        </span>
                        <input
                          type={single ? "radio" : "checkbox"}
                          name={single ? choiceName : undefined}
                          aria-label={`Select ${file.display_name}`}
                          disabled={
                            busy ||
                            file.purge_state === "purged" ||
                            file.purge_state === "pending"
                          }
                          checked={selected.some(
                            (row) => row.file.id === file.id,
                          )}
                          onChange={(event) =>
                            setSelected((rows) =>
                              event.target.checked
                                ? [
                                    ...(single ? [] : rows),
                                    { file, requestId: crypto.randomUUID() },
                                  ]
                                : rows.filter((row) => row.file.id !== file.id),
                            )
                          }
                        />
                      </label>
                    </li>
                  ))}
                </ul>
              </section>
            )
          );
        })}
      </div>
      {!loading && !error && !files.length && <p>No matching files</p>}
      {(error || failure) && <p role="alert">{error || failure}</p>}
      <div className="attachment-actions">
        <Button
          variant="ghost"
          disabled={busy || offset === 0}
          onClick={() => setOffset(Math.max(0, offset - 50))}
        >
          Previous files
        </Button>
        <Button
          variant="ghost"
          disabled={busy || files.length < 50}
          onClick={() => setOffset(offset + 50)}
        >
          Next files
        </Button>
      </div>
      <div className="attachment-actions">
        <span className="attachment-hint">
          {selected.length} selected · No extra copy is created
        </span>
        <Button
          disabled={busy || !selected.length}
          onClick={() => void insert()}
        >
          Insert selected
        </Button>
      </div>
    </div>
  );
}
