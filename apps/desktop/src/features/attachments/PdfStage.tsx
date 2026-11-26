import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { ChevronDown, ChevronUp, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FailureState } from "@/components/ui/failure-alert";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { attachments, type Attachment } from "@/lib/api/attachments";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { openPdf, PdfUnreadable, type PdfDocument } from "./pdf-document";
import {
  COLUMN_PADDING,
  PAGE_GAP,
  fitScale,
  outputScale,
  pageInView,
  pageTops,
  stepZoom,
} from "./pdf-layout";
import { extensionLabel } from "./file-words";
import { PreviewLoading, PreviewState } from "./PreviewState";
import { ViewBar, ViewBarGroup } from "./ViewBar";

type Loaded =
  | { key: string; document: PdfDocument }
  | { key: string; failure: FailureDescription }
  | { key: string; unreadable: true };

/** What the stage's key handler is: the stage takes the keys, this reads them. */
export type StageKeys = RefObject<((event: KeyboardEvent) => void) | null>;

/**
 * A stored PDF: its pages as one scrolling column of paper (DESIGN.md section
 * 10), with a view bar for the page and the zoom. The bytes come from one
 * bounded read of the stored snapshot and are rendered in the WebView by the
 * bundled pdf.js, so nothing is fetched and nothing in the file runs.
 */
export function PdfStage({
  workspace,
  file,
  attempt,
  onRetry,
  scrollerRef,
  keysRef,
}: {
  workspace: string;
  file: Attachment;
  /** Bumped by Retry: the PDF is read again. */
  attempt: number;
  onRetry: () => void;
  /** The scrolling stage this renders into. */
  scrollerRef: RefObject<HTMLElement | null>;
  keysRef: StageKeys;
}) {
  const key = `${workspace}/${file.id}/${attempt}`;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  useEffect(() => {
    let active = true;
    let opened: PdfDocument | null = null;
    void (async () => {
      let bytes: Uint8Array;
      try {
        bytes = await attachments.pdf(workspace, file.id);
      } catch (reason) {
        if (active)
          setLoaded({ key, failure: describeFailure(reason, "read the PDF") });
        return;
      }
      try {
        const document = await openPdf(bytes);
        if (!active) document.destroy();
        else {
          opened = document;
          setLoaded({ key, document });
        }
      } catch (reason) {
        // Damaged, protected, or not a PDF: the fallback names no detail.
        if (active) {
          if (!(reason instanceof PdfUnreadable)) console.warn(reason);
          setLoaded({ key, unreadable: true });
        }
      }
    })();
    return () => {
      active = false;
      opened?.destroy();
    };
  }, [key, workspace, file.id]);
  const current = loaded?.key === key ? loaded : null;
  if (!current) return <PreviewLoading shape="page" />;
  if ("failure" in current)
    return (
      <div className="attachment-pdf-state">
        <FailureState failure={current.failure} onRetry={onRetry} />
      </div>
    );
  if ("unreadable" in current)
    return (
      <div className="attachment-pdf-state">
        <PreviewState
          family="pdf"
          label={extensionLabel(file.original_filename)}
          title="Couldn’t show this PDF"
          sentence="It may be damaged or password-protected. Open it in its app."
        />
      </div>
    );
  return (
    <PdfPages
      key={key}
      document={current.document}
      scrollerRef={scrollerRef}
      keysRef={keysRef}
    />
  );
}

function PdfPages({
  document,
  scrollerRef,
  keysRef,
}: {
  document: PdfDocument;
  scrollerRef: RefObject<HTMLElement | null>;
  keysRef: StageKeys;
}) {
  const { pages } = document;
  const columnRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [page, setPage] = useState(1);
  const [draft, setDraft] = useState<string | null>(null);
  // The point of the document in the middle of the view, kept across a zoom.
  const anchorRef = useRef<number | null>(null);
  // Where the view's middle was when it last scrolled: a resize that changes the Fit
  // scale keeps the same place in view instead of landing on another page.
  const centerRef = useRef<number | null>(null);

  // The stage's width, for Fit.
  useEffect(() => {
    const stage = scrollerRef.current;
    if (!stage) return;
    const measure = () => setWidth(stage.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [scrollerRef]);

  const available = (width || 800) - 2 * COLUMN_PADDING;
  const fit = fitScale(pages, available);
  const scale = zoom === "fit" ? fit : zoom;
  const layout = pageTops(pages, scale);

  /** The column's top, in the stage's scrolling content. */
  function origin(stage: HTMLElement) {
    const top = columnRef.current?.getBoundingClientRect().top ?? 0;
    return top - stage.getBoundingClientRect().top + stage.scrollTop;
  }

  // The page that fills most of the view follows the scroll.
  useEffect(() => {
    const stage = scrollerRef.current;
    if (!stage) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const index = pageInView(
        layout.tops,
        layout.heights,
        stage.scrollTop - origin(stage),
        stage.clientHeight,
      );
      centerRef.current =
        (stage.scrollTop - origin(stage) + stage.clientHeight / 2) /
        layout.total;
      setPage(index + 1);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    stage.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      stage.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
    // `origin` only reads refs; the layout is what changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollerRef, scale, document]);

  function changeZoom(next: number | "fit") {
    const stage = scrollerRef.current;
    if (stage && (next === "fit" ? fit : next) !== scale) {
      const total = layout.total;
      anchorRef.current =
        (stage.scrollTop - origin(stage) + stage.clientHeight / 2) / total;
    }
    setZoom(next);
  }
  useLayoutEffect(() => {
    const stage = scrollerRef.current;
    // A zoom sets its own anchor; a new Fit scale (the stage was resized) keeps the last one.
    const point = anchorRef.current ?? centerRef.current;
    anchorRef.current = null;
    if (!stage || point === null) return;
    stage.scrollTop =
      point * layout.total - stage.clientHeight / 2 + origin(stage);
    centerRef.current =
      (stage.scrollTop - origin(stage) + stage.clientHeight / 2) /
      layout.total;
    // A scroll that did not move (clamped) fires no event, so the page is read here too.
    setPage(
      pageInView(
        layout.tops,
        layout.heights,
        stage.scrollTop - origin(stage),
        stage.clientHeight,
      ) + 1,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale]);

  function jump(target: number) {
    const stage = scrollerRef.current;
    const index = Math.min(Math.max(target, 1), pages.length) - 1;
    setPage(index + 1);
    setDraft(null);
    if (stage) stage.scrollTop = origin(stage) + layout.tops[index]! - PAGE_GAP;
  }
  function commitDraft() {
    const number = Number.parseInt(draft ?? "", 10);
    if (Number.isFinite(number)) jump(number);
    else setDraft(null);
  }

  useEffect(() => {
    // The stage hands every key it hears to the format showing in it.
    keysRef.current = (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("input, textarea, select, [contenteditable]")
      )
        return;
      if (event.key === "+" || event.key === "=")
        changeZoom(stepZoom(scale, 1));
      else if (event.key === "-") changeZoom(stepZoom(scale, -1));
      else if (event.key === "0") changeZoom("fit");
      else return;
      event.preventDefault();
    };
    return () => {
      keysRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keysRef, scale]);

  return (
    <>
      <div ref={columnRef} className="attachment-pdf">
        {pages.map((size, index) => (
          <PdfPage
            key={index}
            document={document}
            index={index}
            size={size}
            scale={scale}
            height={layout.heights[index]!}
            scrollerRef={scrollerRef}
          />
        ))}
      </div>
      <ViewBar label="View">
        {pages.length > 1 && (
          <ViewBarGroup label="Pages">
            <IconButton
              label="Previous page"
              disabled={page <= 1}
              onClick={() => jump(page - 1)}
            >
              <ChevronUp aria-hidden="true" />
            </IconButton>
            <span className="view-bar-page">
              <Input
                variant="inline"
                className="h-6 w-10 text-center"
                inputMode="numeric"
                aria-label="Page"
                data-view-field=""
                value={draft ?? String(page)}
                onChange={(event) => setDraft(event.target.value)}
                onFocus={(event) => event.target.select()}
                onBlur={() => setDraft(null)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commitDraft();
                  }
                }}
              />
            </span>
            <span className="view-bar-of">of {pages.length}</span>
            <IconButton
              label="Next page"
              disabled={page >= pages.length}
              onClick={() => jump(page + 1)}
            >
              <ChevronDown aria-hidden="true" />
            </IconButton>
          </ViewBarGroup>
        )}
        <ViewBarGroup label="Zoom">
          <IconButton
            label="Zoom out"
            shortcut="-"
            onClick={() => changeZoom(stepZoom(scale, -1))}
          >
            <ZoomOut aria-hidden="true" />
          </IconButton>
          <span className="view-bar-value">{Math.round(scale * 100)}%</span>
          <IconButton
            label="Zoom in"
            shortcut="+"
            onClick={() => changeZoom(stepZoom(scale, 1))}
          >
            <ZoomIn aria-hidden="true" />
          </IconButton>
          <Button
            variant="ghost"
            size="compact"
            aria-pressed={zoom === "fit"}
            onClick={() => changeZoom("fit")}
          >
            Fit
          </Button>
        </ViewBarGroup>
      </ViewBar>
    </>
  );
}

/**
 * One page: a paper-sized box that paints its canvas only while it is within a
 * screen of the view, and lets go of it when it is far. A new zoom draws into a
 * fresh canvas and swaps it in, so the page never blanks.
 */
function PdfPage({
  document,
  index,
  size,
  scale,
  height,
  scrollerRef,
}: {
  document: PdfDocument;
  index: number;
  size: { width: number; height: number };
  scale: number;
  height: number;
  scrollerRef: RefObject<HTMLElement | null>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const observed = typeof IntersectionObserver !== "undefined";
  const [near, setNear] = useState(!observed);
  useEffect(() => {
    const element = host.current;
    if (!observed || !element) return;
    const observer = new IntersectionObserver(
      (entries) => setNear(entries.some((entry) => entry.isIntersecting)),
      { root: scrollerRef.current, rootMargin: "100% 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [observed, scrollerRef]);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    if (!near) {
      element.replaceChildren();
      return;
    }
    const canvas = globalThis.document.createElement("canvas");
    const density = outputScale(size, scale, window.devicePixelRatio || 1);
    const render = document.render(index, canvas, scale * density);
    // A cancelled render still resolves `done`; only a live one may swap in.
    let live = true;
    render.done.then(
      () => {
        if (live) element.replaceChildren(canvas);
      },
      // A page that does not draw stays blank paper; the others still read.
      () => {},
    );
    return () => {
      live = false;
      render.cancel();
    };
  }, [near, document, index, size, scale]);
  return (
    <div
      ref={host}
      className="attachment-pdf-page"
      role="img"
      aria-label={`Page ${index + 1}`}
      data-page={index + 1}
      style={{ width: Math.round(size.width * scale), height }}
    />
  );
}
