import { useState } from "react";
import { AlertTriangle, Check, ExternalLink } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { DialogShell } from "@/components/ui/dialog-shell";
import { FailureAlert } from "@/components/ui/failure-alert";
import {
  exportMarkdown,
  type MarkdownExport,
  type MarkdownExportSource,
} from "@/lib/api/portable-export";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";

/**
 * Exports Markdown with its files into a folder the person picks, then shows
 * what was written. `run` starts it from any trigger (a button, a menu item);
 * render `element` where its progress, failure and result dialog belong.
 * `returnFocus` is where focus goes when the result dialog closes.
 */
export function useMarkdownExport(
  source: MarkdownExportSource | (() => MarkdownExportSource),
  returnFocus?: React.RefObject<HTMLElement | null>,
) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FailureDescription | null>(null);
  const [result, setResult] = useState<MarkdownExport | null>(null);
  async function run() {
    setBusy(true);
    setError(null);
    try {
      // Capture the selection before the native folder dialog takes focus.
      const content = typeof source === "function" ? source() : source;
      const output = await open({
        title: "Export Markdown with files into folder",
        directory: true,
        multiple: false,
      });
      if (typeof output === "string")
        setResult(await exportMarkdown(content, output));
    } catch (reason) {
      setError(describeFailure(reason, "export Markdown"));
    } finally {
      setBusy(false);
    }
  }
  async function reveal(path: string) {
    try {
      await revealItemInDir(`${result?.directory}/${path}`);
    } catch (reason) {
      setError(describeFailure(reason, "show the file in its folder"));
    }
  }
  const element = (
    <>
      {busy && (
        <span role="status" className="sr-only">
          Exporting Markdown with files…
        </span>
      )}
      {error && !result && (
        <FailureAlert
          size="compact"
          failure={error}
          onRetry={() => void run()}
        />
      )}
      {result && (
        <DialogShell
          open
          onOpenChange={(next) => {
            if (!next) setResult(null);
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
              onClick={() => void reveal(result.manifest_path)}
            >
              Show manifest
            </Button>
          }
          onSubmit={() => void reveal(result.markdown_path)}
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
      )}
    </>
  );
  return { run, busy, element };
}
