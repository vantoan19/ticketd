import type { RefObject } from "react";
import { AlertTriangle, Check, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DialogShell } from "@/components/ui/dialog-shell";
import { FailureAlert } from "@/components/ui/failure-alert";
import type { MarkdownExport } from "@/lib/api/portable-export";
import type { FailureDescription } from "@/lib/api/describe-failure";

/** What an export wrote, with Show Markdown and Show manifest. */
export function ExportResult({
  result,
  error,
  reveal,
  onClose,
  returnFocus,
}: {
  result: MarkdownExport;
  error: FailureDescription | null;
  reveal: (path: string) => void;
  onClose: () => void;
  returnFocus?: RefObject<HTMLElement | null>;
}) {
  return (
    <DialogShell
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      {...(returnFocus && { returnFocus })}
      title={
        result.status === "partial"
          ? "Export partially complete"
          : "Export complete"
      }
      description="Markdown uses relative paths, and each local file is copied once. Drive references remain links. Uploaded copies are downloaded only when their bytes match the recorded upload; changed, unknown or unavailable copies are omitted. Your content in ticketd is unchanged."
      primaryLabel="Show Markdown"
      cancelLabel="Done"
      showClose={false}
      blockedReason={null}
      error={error && <FailureAlert size="compact" failure={error} />}
      footerLeading={
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => reveal(result.manifest_path)}
        >
          Show manifest
        </Button>
      }
      onSubmit={() => reveal(result.markdown_path)}
    >
      {result.status === "partial" && (
        <p role="status" className="portable-export-warning">
          <AlertTriangle size={16} aria-hidden="true" />
          Some file bytes were omitted. Review the manifest before sharing.
        </p>
      )}
      <dl className="portable-export-summary" aria-label="Export summary">
        {(
          [
            [
              "Local files",
              new Set(
                result.attachments.flatMap((file) =>
                  file.path ? [file.path] : [],
                ),
              ).size,
            ],
            [
              "External links",
              new Set(
                result.attachments.flatMap((file) =>
                  file.external_url ? [file.external_url] : [],
                ),
              ).size,
            ],
            [
              "Omissions",
              result.attachments.filter((file) => file.omission).length,
            ],
          ] as const
        ).map(([label, count]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{count}</dd>
          </div>
        ))}
      </dl>
      {result.attachments.some((file) => file.external_url) && (
        <p className="text-sm">
          Drive files remain online. Recipients need access in Google Drive;
          this export does not include their bytes.
        </p>
      )}
      <p className="break-all text-sm">{result.directory}</p>
      <ul
        className="portable-export-files"
        aria-label="Exported files and omissions"
      >
        {result.attachments.map((file) => (
          <li key={file.uri}>
            {file.omission ? (
              <AlertTriangle size={16} aria-hidden="true" />
            ) : file.path ? (
              <Check size={16} aria-hidden="true" />
            ) : (
              <ExternalLink size={16} aria-hidden="true" />
            )}
            <div>
              <strong>{file.display_name}</strong>
              <p>
                {file.omission ??
                  (file.path
                    ? `${file.kind === "uploaded_copy" ? "Verified uploaded copy" : "Copied"} · ${file.path}`
                    : "External link · current provider content; no local bytes")}
              </p>
              {file.external_url && (
                <p className="break-all">{file.external_url}</p>
              )}
            </div>
          </li>
        ))}
      </ul>
      {result.status === "partial" && (
        <p role="status">
          Omitted files keep their readable references. Review the manifest
          before sharing.
        </p>
      )}
    </DialogShell>
  );
}
