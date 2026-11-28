import { useContext } from "react";
import { RecordLink } from "@/components/ui/record-link";
import { Time } from "@/components/ui/time";
import { DocumentNavigation } from "@/features/documents/navigation";
import { storageWord } from "@/features/sync-review/availability";
import { TicketNavigation } from "@/features/tickets/navigation";
import { DriveReferenceDetails } from "./DriveReferenceDetails";
import { fileType } from "./file-words";
import { formatSize } from "./format-size";
import type { Preview } from "./use-attachment-preview";

/** Where a file is used, as the "Used in" list names each place. */
const usageKinds: Record<string, string> = {
  ticket_attachment: "Attached to the ticket",
  ticket_body: "Ticket description",
  document_body: "Document",
  activity_brief: "Update details",
  draft: "Unsaved draft",
  undo: "Kept for Undo",
};

/** "On this computer", "Google Drive · Uploaded copy", "Not downloaded". */
function storedWord(preview: Preview) {
  if (preview.external)
    return preview.uploadedCopy
      ? "Google Drive · Uploaded copy"
      : "Google Drive · External reference";
  return storageWord(preview.stored);
}

/** The facts under (or beside) the stage: storage, type, size, age, uses. */
export function PreviewFacts({
  preview,
  onNavigate,
}: {
  preview: Preview;
  onNavigate: () => void;
}) {
  const { file, info, external, uploadedCopy, attempt } = preview;
  const openDocument = useContext(DocumentNavigation);
  const openTicket = useContext(TicketNavigation);
  if (!file) return null;
  const type = fileType(file.original_filename, info?.media_type);
  return (
    <div className="attachment-preview-facts">
      <dl className="attachment-facts">
        {external ? (
          <DriveReferenceDetails
            id={file.id}
            revision={attempt}
            uploadedCopy={uploadedCopy}
          />
        ) : (
          <>
            <dt>Stored</dt>
            <dd>{storedWord(preview)}</dd>
            <dt>Type</dt>
            <dd>{type.word}</dd>
            <dt>Size</dt>
            <dd>
              {file.size_bytes != null
                ? formatSize(file.size_bytes)
                : "Not recorded"}
            </dd>
          </>
        )}
        <dt>Added</dt>
        <dd>
          {file.added_at ? (
            <Time value={file.added_at} />
          ) : (
            <span className="attachment-facts-muted">Not recorded</span>
          )}
        </dd>
        {file.original_filename !== file.display_name && (
          <>
            <dt>Original name</dt>
            <dd className="attachment-facts-name">{file.original_filename}</dd>
          </>
        )}
        {info?.html && (
          <>
            <dt>Preview</dt>
            <dd>Read-only, offline · Scripts and network are off</dd>
          </>
        )}
        <dt>Used in</dt>
        <dd>
          {!info ? (
            <span className="attachment-facts-muted">…</span>
          ) : info.usage.total === 0 ? (
            info.usage.legacy_drafts_pending ? (
              "Kept for recovery"
            ) : (
              "Unused"
            )
          ) : (
            <>
              <h3 className="sr-only">Used in {info.usage.total}</h3>
              <ul className="attachment-uses" aria-label="Attachment usage">
                {info.usage.entries.map((entry) => (
                  <li key={`${entry.kind}:${entry.owner}`}>
                    {(entry.target?.kind === "ticket" && openTicket) ||
                    (entry.target?.kind === "document" && openDocument) ? (
                      <RecordLink
                        onClick={() => {
                          onNavigate();
                          if (entry.target?.kind === "ticket")
                            openTicket?.(entry.target.id);
                          else if (entry.target?.kind === "document")
                            openDocument?.(entry.target.id);
                        }}
                      >
                        {entry.label}
                      </RecordLink>
                    ) : (
                      <span>{entry.label}</span>
                    )}
                    <small>
                      {usageKinds[entry.kind] ?? entry.kind}
                      {entry.trashed ? " · In Trash" : ""}
                    </small>
                  </li>
                ))}
              </ul>
              {info.usage.total > info.usage.entries.length && (
                <small className="attachment-facts-muted">
                  And {info.usage.total - info.usage.entries.length} more.
                </small>
              )}
            </>
          )}
        </dd>
      </dl>
    </div>
  );
}
