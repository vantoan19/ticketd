import { useState, type RefObject } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { ExportResult } from "./ExportResult";
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
 * Exports `source` as Markdown with its files into a folder the person picks,
 * then shows what was written. For a trigger that is not a button of its own
 * (a menu item): call `run`, render `ui` where the result dialog may mount,
 * and show `error` where that trigger's outcomes go. Focus returns to
 * `returnFocus` when the result dialog closes.
 */
export function useMarkdownExport(
  source: MarkdownExportSource | (() => MarkdownExportSource),
  returnFocus?: RefObject<HTMLElement | null>,
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
  const ui = (
    <>
      {busy && (
        <span role="status" className="sr-only">
          Exporting Markdown with files…
        </span>
      )}
      {result && (
        <ExportResult
          result={result}
          error={error}
          reveal={(path) => void reveal(path)}
          onClose={() => setResult(null)}
          {...(returnFocus && { returnFocus })}
        />
      )}
    </>
  );
  /** `error` is the failure to show beside the trigger; a result shows its own. */
  return { run, busy, error: result ? null : error, ui };
}
