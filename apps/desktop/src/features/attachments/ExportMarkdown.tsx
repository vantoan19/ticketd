import { useRef } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import type { MarkdownExportSource } from "@/lib/api/portable-export";
import { useMarkdownExport } from "./use-markdown-export";

export function ExportMarkdownButton({
  source,
  compact = false,
  label = "Export Markdown with files",
}: {
  source: MarkdownExportSource | (() => MarkdownExportSource);
  compact?: boolean;
  label?: string;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const { run, busy, element } = useMarkdownExport(source, trigger);
  return (
    <>
      {compact ? (
        <IconButton
          ref={trigger}
          type="button"
          label={label}
          disabled={busy}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void run()}
        >
          <Download aria-hidden="true" />
        </IconButton>
      ) : (
        <Button
          ref={trigger}
          type="button"
          size="sm"
          variant="ghost"
          aria-label={label}
          disabled={busy}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void run()}
        >
          <Download aria-hidden="true" />
          {busy ? "Exporting…" : label}
        </Button>
      )}
      {element}
    </>
  );
}
