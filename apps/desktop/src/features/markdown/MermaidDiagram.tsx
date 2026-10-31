import { useEffect, useId, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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

type Result = { source: string; dark: boolean; svg: string; error: string };

export function MermaidDiagram({ source }: { source: string }) {
  const dark = useDarkTheme();
  const [result, setResult] = useState<Result | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [zoom, setZoom] = useState(100);
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
            error: `Could not render this diagram. ${reason instanceof Error && /limit|configuration|external resources/.test(reason.message) ? reason.message : "Check its source in the editor."}`,
          });
      },
    );
    return () => {
      active = false;
    };
  }, [source, dark]);
  const current =
    result?.source === source && result.dark === dark ? result : null;
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
          <span>Mermaid</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={sourceVisible}
            aria-controls={sourceId}
            disabled={Boolean(current?.error)}
            onClick={() => setShowSource((value) => !value)}
          >
            {sourceVisible ? "Hide source" : "Show source"}
          </Button>
          <CopySourceButton label="Copy source" source={source} />
          <DialogTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!current?.svg}
            >
              Expand diagram
            </Button>
          </DialogTrigger>
        </div>
        {current?.error ? (
          <Alert variant="destructive">
            <AlertDescription>{current.error}</AlertDescription>
          </Alert>
        ) : !current ? (
          <p role="status" className="p-3 text-muted-foreground">
            Rendering diagram…
          </p>
        ) : !expanded ? (
          <>
            {zoomControls}
            {diagram}
          </>
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
        <DialogContent className="mermaid-expanded">
          <DialogHeader>
            <DialogTitle>Expanded Mermaid diagram</DialogTitle>
            <DialogDescription>
              Scroll to explore the diagram, or adjust its zoom. Escape closes
              this view.
            </DialogDescription>
          </DialogHeader>
          {zoomControls}
          {diagram}
          <CopySourceButton label="Copy source" source={source} />
        </DialogContent>
      </Dialog>
    </section>
  );
}
