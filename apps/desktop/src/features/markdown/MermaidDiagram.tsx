import { useEffect, useId, useState } from "react";
import { Code, Maximize2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { CopySourceButton } from "./CopySourceButton";
import { renderDiagram } from "./mermaid-renderer";
import { useDarkTheme } from "@/lib/preferences";

type Result = {
  source: string;
  dark: boolean;
  svg: string;
  error: string;
  detail?: string;
};

export function MermaidDiagram({ source }: { source: string }) {
  const dark = useDarkTheme();
  const [result, setResult] = useState<Result | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [attempt, setAttempt] = useState(0);
  const sourceId = useId();
  useEffect(() => {
    let active = true;
    void renderDiagram(source, dark, () => active).then(
      (svg) => {
        if (active) setResult({ source, dark, svg, error: "" });
      },
      (reason: unknown) => {
        if (active)
          setResult({
            source,
            dark,
            svg: "",
            detail: reason instanceof Error ? reason.message : String(reason),
            error: `Could not render this diagram. ${reason instanceof Error && /limit|configuration|external resources/.test(reason.message) ? reason.message : "Check its source in the editor."}`,
          });
      },
    );
    return () => {
      active = false;
    };
  }, [source, dark, attempt]);
  const current =
    result?.source === source && result.dark === dark ? result : null;
  const unpainted = !current || Boolean(current.error);
  // A window that was hidden while the diagram rendered paints it when shown again.
  useEffect(() => {
    if (!unpainted) return;
    const retry = () => {
      if (document.visibilityState !== "hidden") setAttempt((n) => n + 1);
    };
    window.addEventListener("focus", retry);
    document.addEventListener("visibilitychange", retry);
    return () => {
      window.removeEventListener("focus", retry);
      document.removeEventListener("visibilitychange", retry);
    };
  }, [unpainted]);
  const sourceVisible = showSource || Boolean(current?.error);
  const zoomControls = (
    <div className="markdown-block-toolbar">
      <span>Zoom</span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label="Zoom out"
        disabled={zoom <= 50}
        onClick={() => setZoom((value) => Math.max(50, value - 25))}
      >
        −
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label="Reset zoom"
        onClick={() => setZoom(100)}
      >
        {zoom}%
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label="Zoom in"
        disabled={zoom >= 300}
        onClick={() => setZoom((value) => Math.min(300, value + 25))}
      >
        +
      </Button>
    </div>
  );
  const diagram = current?.svg ? (
    <div
      className="mermaid-viewer"
      tabIndex={0}
      role="region"
      aria-label="Scrollable diagram"
    >
      <div
        className="mermaid-canvas"
        style={{ zoom: zoom / 100 }}
        role="img"
        aria-label="Mermaid diagram"
        dangerouslySetInnerHTML={{ __html: current.svg }}
      />
    </div>
  ) : null;
  return (
    <section
      className="mermaid-block"
      aria-label="Mermaid block"
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <div className="markdown-block-toolbar">
          <span>Mermaid diagram</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={sourceVisible}
            aria-controls={sourceId}
            disabled={Boolean(current?.error)}
            onClick={() => setShowSource((value) => !value)}
          >
            <Code aria-hidden="true" />
            Source
          </Button>
          <CopySourceButton label="Copy" icon source={source} />
          <DialogTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!current?.svg}
            >
              <Maximize2 aria-hidden="true" />
              Expand
            </Button>
          </DialogTrigger>
        </div>
        {current?.error ? (
          <Alert tone="error" data-reason={current.detail}>
            <AlertDescription>{current.error}</AlertDescription>
          </Alert>
        ) : !current ? (
          // A block-sized skeleton: the diagram arrives in place without moving the text below.
          <div role="status" className="mermaid-pending">
            <Skeleton aria-hidden="true" className="h-full w-full" />
            <span className="sr-only">Rendering diagram…</span>
          </div>
        ) : !expanded ? (
          diagram
        ) : null}
        {sourceVisible && (
          <pre
            id={sourceId}
            className="mermaid-source"
            aria-label="Mermaid source"
            tabIndex={0}
          >
            {source}
          </pre>
        )}
        <DialogContent className="mermaid-expanded" size="viewer">
          <DialogHeader>
            <DialogTitle>Expanded Mermaid diagram</DialogTitle>
            <DialogDescription>
              Scroll to explore the diagram, or adjust its zoom. Escape closes
              this view.
            </DialogDescription>
          </DialogHeader>
          {zoomControls}
          {diagram}
          <CopySourceButton label="Copy source" icon source={source} />
        </DialogContent>
      </Dialog>
    </section>
  );
}
