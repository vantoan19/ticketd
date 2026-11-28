import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import type { Attachment } from "@/lib/api/attachments";
import { fitScale, type Size } from "./image-layout";
import { stepZoom } from "./pdf-layout";
import type { StageKeys } from "./PdfStage";
import { ViewBar, ViewBarGroup } from "./ViewBar";

/** The room around the picture inside the stage: 20px, and 72px under it for the bar. */
const PAD = 20;
const BAR_ROOM = 72;
const DRAG_THRESHOLD = 4;

/**
 * A picture in the viewer: it fits inside the stage above the view bar on its own
 * checkerboard, and the stage stays recessed. The bar is the zoom group
 * ("- 66% + · Fit"); clicking the picture toggles Fit and 100%, and dragging
 * pans an overflowing picture. + - 0 zoom and fit while the stage has focus.
 */
export function ImageStage({
  file,
  url,
  onError,
  scrollerRef,
  keysRef,
}: {
  file: Attachment;
  url: string;
  onError: () => void;
  scrollerRef: RefObject<HTMLElement | null>;
  keysRef: StageKeys;
}) {
  const image = useRef<HTMLImageElement>(null);
  const [natural, setNatural] = useState<Size | null>(null);
  const [room, setRoom] = useState<Size>({ width: 0, height: 0 });
  // The width the stage shows, which the bar spans so it stays centered while it scrolls.
  const [shown, setShown] = useState(0);
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [dragging, setDragging] = useState(false);
  const dragListeners = useRef<AbortController | null>(null);
  const suppressClick = useRef(false);
  // The point of the picture in the middle of the view, kept across a zoom.
  const anchor = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => () => dragListeners.current?.abort(), []);

  useEffect(() => {
    const picture = image.current;
    // Strict Mode rehearses cleanup/setup; restore the source on each setup too.
    picture?.setAttribute("src", url);
    return () => picture?.removeAttribute("src");
  }, [url]);

  // The space the picture has: the stage inside its own padding and the picture's.
  useEffect(() => {
    const stage = scrollerRef.current;
    if (!stage) return;
    const measure = () => {
      const style = getComputedStyle(stage);
      const inset = (side: "Left" | "Right" | "Top" | "Bottom") =>
        Number.parseFloat(style[`padding${side}`]) || 0;
      const visible = stage.clientWidth - inset("Left") - inset("Right");
      setShown(visible);
      setRoom({
        width: visible - 2 * PAD,
        height:
          stage.clientHeight - inset("Top") - inset("Bottom") - PAD - BAR_ROOM,
      });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [scrollerRef]);

  const fit = natural ? fitScale(natural, room) : 1;
  const scale = zoom === "fit" ? fit : zoom;

  function startPan(event: ReactPointerEvent<HTMLImageElement>) {
    if (event.button !== 0) return;
    suppressClick.current = false;
    const stage = scrollerRef.current;
    // Touch already pans the scroll container with the platform's gestures.
    if (
      event.pointerType !== "mouse" ||
      !stage ||
      (stage.scrollWidth <= stage.clientWidth &&
        stage.scrollHeight <= stage.clientHeight)
    )
      return;
    const { pointerId, currentTarget } = event;
    currentTarget.setPointerCapture(pointerId);
    dragListeners.current?.abort();
    const controller = new AbortController();
    dragListeners.current = controller;
    const options = { signal: controller.signal };
    let x = event.clientX;
    let y = event.clientY;

    function endPan() {
      controller.abort();
      dragListeners.current = null;
      setDragging(false);
    }
    function endPointer(pointer: PointerEvent) {
      if (pointer.pointerId === pointerId) endPan();
    }
    // Listen through the end of the gesture even if the pointer crosses the
    // toolbar or the edge of the preview.
    window.addEventListener(
      "pointermove",
      (pointer) => {
        if (pointer.pointerId !== pointerId) return;
        const dx = pointer.clientX - x;
        const dy = pointer.clientY - y;
        if (!suppressClick.current) {
          if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
          suppressClick.current = true;
          setDragging(true);
        }
        stage.scrollLeft -= dx;
        stage.scrollTop -= dy;
        x = pointer.clientX;
        y = pointer.clientY;
      },
      options,
    );
    window.addEventListener("pointerup", endPointer, options);
    window.addEventListener("pointercancel", endPointer, options);
    window.addEventListener("lostpointercapture", endPointer, options);
    window.addEventListener("blur", endPan, options);
  }

  function changeZoom(next: number | "fit") {
    const stage = scrollerRef.current;
    if (stage && (next === "fit" ? fit : next) !== scale) {
      anchor.current = {
        x: (stage.scrollLeft + stage.clientWidth / 2) / stage.scrollWidth,
        y: (stage.scrollTop + stage.clientHeight / 2) / stage.scrollHeight,
      };
    }
    setZoom(next);
  }
  useLayoutEffect(() => {
    const stage = scrollerRef.current;
    const point = anchor.current;
    if (!stage || !point) return;
    anchor.current = null;
    stage.scrollLeft = point.x * stage.scrollWidth - stage.clientWidth / 2;
    stage.scrollTop = point.y * stage.scrollHeight - stage.clientHeight / 2;
    // Only a new scale moves the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale]);

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
  }, [keysRef, scale, fit]);

  const fitted = zoom === "fit";
  const pannable =
    natural &&
    (Math.round(natural.width * scale) > room.width ||
      Math.round(natural.height * scale) > room.height);
  return (
    <>
      <div className="attachment-picture">
        <img
          ref={image}
          className="attachment-preview-image"
          src={url}
          alt={file.display_name}
          draggable={false}
          // A click toggles between the picture fitted and at its own size.
          data-zoom={fitted ? "in" : "out"}
          data-pannable={pannable ? "" : undefined}
          data-dragging={dragging ? "" : undefined}
          style={
            natural
              ? { width: Math.round(natural.width * scale), height: "auto" }
              : undefined
          }
          onLoad={(event) => {
            const { naturalWidth: width, naturalHeight: height } =
              event.currentTarget;
            if (width > 0 && height > 0) setNatural({ width, height });
          }}
          onPointerDown={startPan}
          onClick={() => {
            if (!suppressClick.current) changeZoom(fitted ? 1 : "fit");
            suppressClick.current = false;
          }}
          onError={onError}
        />
      </div>
      <div
        className="attachment-picture-bar"
        style={
          shown
            ? ({ "--stage-width": `${shown}px` } as CSSProperties)
            : undefined
        }
      >
        <ViewBar label="View">
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
              aria-pressed={fitted}
              onClick={() => changeZoom("fit")}
            >
              Fit
            </Button>
          </ViewBarGroup>
        </ViewBar>
      </div>
    </>
  );
}
