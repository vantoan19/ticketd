import { useId, useState } from "react";
import { SearchX } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { FailureState } from "@/components/ui/failure-alert";
import { Pager } from "@/components/ui/pager";
import { SearchInput } from "@/components/ui/search-input";
import type { Attachment } from "@/lib/api/attachments";
import { ATTACHMENT_PAGE, useAttachmentSearch } from "./use-attachment-search";
import { formatSize } from "./format-size";
import { usageContext } from "./usage-context";
import { AttachmentThumbnail } from "./AttachmentThumbnail";
import { fileType, purged } from "./file-words";

/** One chosen file and the request identity its insertion keeps on retry. */
export type ExistingChoice = { file: Attachment; requestId: string };

/**
 * The Existing files tab: search first (a pasted ticketd link finds its
 * file), then the files related to this ticket and the rest of the workspace,
 * each with its checkbox (a radio when one file replaces a reference) on the
 * left. The picker owns the selection and inserts it from its footer.
 */
export function ExistingAttachments({
  ticketReference,
  selected,
  onSelectedChange,
  busy,
  single = false,
}: {
  ticketReference: string | null;
  selected: ExistingChoice[];
  onSelectedChange: (next: ExistingChoice[]) => void;
  busy: boolean;
  single?: boolean;
}) {
  const choiceName = useId();
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(ATTACHMENT_PAGE);
  const [refresh, setRefresh] = useState(0);
  const { files, loading, pending, error, answered, more } =
    useAttachmentSearch(search, "all", ticketReference, limit, refresh);
  const query = answered.search.trim();
  return (
    <div className="attachment-existing">
      <SearchInput
        size="default"
        aria-label="Search existing files"
        placeholder="Search files by name, or paste a link…"
        autoFocus
        value={search}
        onValueChange={(value) => {
          setSearch(value);
          setLimit(ATTACHMENT_PAGE);
        }}
        fill
      />
      <div className="attachment-existing-results" aria-busy={pending}>
        {error ? (
          <FailureState
            failure={error}
            onRetry={() => setRefresh((value) => value + 1)}
          />
        ) : loading ? null : !files.length ? (
          query ? (
            <EmptyState
              icon={<SearchX />}
              title={`No files match “${query}”`}
            />
          ) : (
            <EmptyState
              title="No files in this workspace yet"
              description="Upload a file and it can be reused here."
            />
          )
        ) : (
          <div
            role={single ? "radiogroup" : undefined}
            aria-label={single ? "Existing file choice" : undefined}
          >
            {[true, false].map((related) => {
              const group = files.filter((row) => row.related === related);
              const label = related
                ? "Related to this ticket"
                : ticketReference
                  ? "Elsewhere in the workspace"
                  : "In this workspace";
              return (
                group.length > 0 && (
                  <section key={String(related)} aria-label={label}>
                    {/* One group needs no label of its own. */}
                    {ticketReference && (
                      <p className="attachment-existing-group">{label}</p>
                    )}
                    <ul>
                      {group.map(({ attachment: file, usage }) => {
                        const unavailable = purged(file);
                        const checked = selected.some(
                          (row) => row.file.id === file.id,
                        );
                        return (
                          <li key={file.id}>
                            <label
                              className="attachment-choice"
                              data-checked={checked || undefined}
                              data-disabled={unavailable || undefined}
                            >
                              <input
                                type={single ? "radio" : "checkbox"}
                                name={single ? choiceName : undefined}
                                aria-label={`Select ${file.display_name}`}
                                disabled={busy || unavailable}
                                checked={checked}
                                onChange={(event) =>
                                  onSelectedChange(
                                    event.target.checked
                                      ? [
                                          ...(single ? [] : selected),
                                          {
                                            file,
                                            requestId: crypto.randomUUID(),
                                          },
                                        ]
                                      : selected.filter(
                                          (row) => row.file.id !== file.id,
                                        ),
                                  )
                                }
                              />
                              <AttachmentThumbnail file={file} size="row" />
                              <span className="attachment-choice-text">
                                <span className="attachment-choice-name">
                                  {file.display_name}
                                </span>
                                <small>
                                  {[
                                    fileType(file.original_filename).word,
                                    file.size_bytes !== null &&
                                      formatSize(file.size_bytes),
                                    unavailable
                                      ? "Deleted permanently"
                                      : usageContext(usage),
                                  ]
                                    .filter(Boolean)
                                    .join(" · ")}
                                </small>
                              </span>
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                )
              );
            })}
            {more && (
              <Pager
                more={ATTACHMENT_PAGE}
                noun="files"
                loading={pending}
                onMore={() => setLimit((value) => value + ATTACHMENT_PAGE)}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
