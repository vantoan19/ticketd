import { useState } from "react";
import { AlertTriangle, Check, Download, ExternalLink } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  exportMarkdown,
  type MarkdownExport,
  type MarkdownExportSource,
} from "@/lib/api/portable-export";

export function ExportMarkdownButton({
  source,
  compact = false,
  label = "Export Markdown with files",
}: {
  source: MarkdownExportSource | (() => MarkdownExportSource);
  compact?: boolean;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<MarkdownExport | null>(null);
  async function run() {
    setBusy(true);
    setError("");
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
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }
  async function reveal(path: string) {
    try {
      await revealItemInDir(`${result?.directory}/${path}`);
    } catch (reason) {
      setError(String(reason));
    }
  }
  return (
    <>
      <Button
        type="button"
        size={compact ? "icon-sm" : "sm"}
        variant="ghost"
        aria-label={label}
        title={label}
        disabled={busy}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => void run()}
      >
        <Download aria-hidden="true" />
        {!compact && (busy ? "Exporting…" : label)}
      </Button>
      {busy && (
        <span role="status" className="sr-only">
          Exporting Markdown with files…
        </span>
      )}
      {error && !result && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      {result && (
        <Dialog
          open
          onOpenChange={(next) => {
            if (!next) setResult(null);
          }}
        >
          <DialogContent className="portable-export-dialog">
            <DialogHeader>
              <DialogTitle>
                {result.status === "partial"
                  ? "Export partially complete"
                  : "Export complete"}
              </DialogTitle>
              <DialogDescription>
                Markdown uses relative paths. Each local file is copied once;
                external files remain provider links. Your content in ticketd is
                unchanged.
              </DialogDescription>
            </DialogHeader>
            {result.status === "partial" && (
              <p role="status" className="portable-export-warning">
                <AlertTriangle size={16} aria-hidden="true" />
                Some file bytes were omitted. Review the manifest before
                sharing.
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
                          ? `Copied · ${file.path}`
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
                Missing files keep their readable references. Review the
                manifest before sharing.
              </p>
            )}
            {error && (
              <p role="alert" className="text-destructive text-sm">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={() => setResult(null)}>
                Done
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void reveal(result.manifest_path)}
              >
                Show manifest
              </Button>
              <Button
                size="sm"
                onClick={() => void reveal(result.markdown_path)}
              >
                Show Markdown
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
