import { Maximize2, X } from "lucide-react";
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type MouseEvent,
} from "react";
import { usePopupViewport } from "../components/usePopupViewport";
import { captures, regionOf, viewportOf, type Focus } from "./captures";
import {
  CaptureLink,
  ProductImage,
  compactScreen,
  imageUrl,
  useImageTheme,
  type CaptureView,
} from "./ProductImage";

const isCompact = () => !!window.matchMedia?.(compactScreen).matches;
function subscribeCompact(notify: () => void) {
  const query = window.matchMedia?.(compactScreen);
  query?.addEventListener?.("change", notify);
  return () => query?.removeEventListener?.("change", notify);
}

export function ScreenZoom({
  focus,
  label = "Full screen",
}: {
  focus: Focus;
  label?: string;
}) {
  const { screen } = focus;
  const compact = useSyncExternalStore(
    subscribeCompact,
    isCompact,
    () => false,
  );
  const { width, height } = viewportOf(screen, compact);
  const point = regionOf(focus, compact);
  const info = captures[screen];
  const [expanded, setExpanded] = useState(false);
  const [dialog, setDialog] = useState<HTMLDialogElement | null>(null);
  const opener = useRef<HTMLAnchorElement>(null);
  const imagePane = useRef<HTMLDivElement>(null);
  const [zoomed, setZoomed] = useState(false);
  const [failure, setFailure] = useState<"failed" | "retrying">();

  const [fitScale, setFitScale] = useState(1);
  const titleId = useId();
  const resolvedTheme = useImageTheme();
  const source = imageUrl(screen, resolvedTheme ?? "light", width, compact);
  const [attempts, setAttempts] = useState<Record<string, number>>({});
  const attempt = attempts[source] ?? 0;
  const view: CaptureView | undefined =
    resolvedTheme === "light" || resolvedTheme === "dark"
      ? { tone: resolvedTheme, compact }
      : undefined;
  usePopupViewport(dialog);
  useLayoutEffect(() => {
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    const doc = dialog.ownerDocument;
    doc.documentElement.setAttribute("data-proof-open", "");
    return () => {
      const others = doc.querySelectorAll(".proof-dialog[open]");
      if (!Array.from(others).some((open) => open !== dialog))
        doc.documentElement.removeAttribute("data-proof-open");
    };
  }, [dialog]);
  function fitWindow() {
    // Fit at the reader's current magnification. A subsequent pinch should
    // still enlarge the photograph, just as it enlarges the surrounding type.
    setFitScale(Math.max(1, window.visualViewport?.scale ?? 1));
    setZoomed(false);
  }
  function open(event: MouseEvent<HTMLAnchorElement>) {
    if (
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey ||
      typeof HTMLDialogElement === "undefined" ||
      !HTMLDialogElement.prototype.showModal
    )
      return;
    opener.current = event.currentTarget;
    event.preventDefault();
    fitWindow();
    setFailure(undefined);
    setExpanded(true);
  }
  useLayoutEffect(() => {
    const pane = imagePane.current;
    if (!zoomed || !pane) return;
    const reveal = () => {
      pane.scrollLeft = Math.max(0, point.x - pane.clientWidth * 0.35);
      pane.scrollTop = Math.max(0, point.y - pane.clientHeight * 0.45);
    };
    reveal();
    // Rotating the device or resizing the window can put the selected control
    // outside the crop even when the same native screenshot still fits.
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(reveal);
      observer.observe(pane);
      return () => observer.disconnect();
    }
    window.addEventListener("resize", reveal);
    return () => window.removeEventListener("resize", reveal);
  }, [zoomed, point]);
  function changeImage() {
    if (failure === "retrying") return;
    if (failure) {
      // Reopening this screenshot should reuse its successful retry.
      setFailure("retrying");
      setAttempts((previous) => ({
        ...previous,
        [source]: (previous[source] ?? 0) + 1,
      }));
    } else if (zoomed) fitWindow();
    else setZoomed(true);
  }
  const zoomLabel = zoomed ? "Fit to window" : "Actual size";
  const reloadLabel =
    failure === "retrying" ? "Loading screenshot…" : "Reload screenshot";
  return (
    <>
      <CaptureLink
        screen={screen}
        view={view}
        onClick={open}
        label={label + " · " + info.title}
      >
        <Maximize2 size={14} aria-hidden="true" />
        <span>{label}</span>
      </CaptureLink>
      {expanded && (
        <dialog
          ref={setDialog}
          className="proof-dialog"
          aria-labelledby={titleId}
          style={{ "--fit-scale": fitScale } as CSSProperties}
          onClose={() => {
            setExpanded(false);
            setZoomed(false);
            opener.current?.focus({ preventScroll: true });
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) e.currentTarget.close();
          }}
        >
          <div className="proof-dialog-inner">
            <header>
              <h3 id={titleId}>ticketd / {info.title}</h3>
              <div className="zoom-tools">
                <button
                  type="button"
                  aria-pressed={failure ? undefined : zoomed}
                  aria-disabled={failure === "retrying" || undefined}
                  onClick={changeImage}
                >
                  {failure ? reloadLabel : zoomLabel}
                </button>
                <button
                  type="button"
                  autoFocus
                  onClick={() => dialog?.close()}
                  aria-label="Close screenshot"
                >
                  <X size={20} />
                </button>
              </div>
            </header>
            <div
              className="proof-dialog-image"
              data-zoomed={zoomed}
              data-unavailable={failure ? true : undefined}
              aria-busy={failure === "retrying" || undefined}
              style={
                {
                  "--image-native-width": width + "px",
                  "--image-native-height": height + "px",
                  "--image-aspect": width / height,
                } as CSSProperties
              }
              ref={imagePane}
              tabIndex={zoomed ? 0 : undefined}
              role="region"
              aria-label="Product screenshot"
            >
              {failure && (
                <span className="full-image-failure" role="status">
                  The screenshot couldn’t load.
                </span>
              )}
              <ProductImage
                attempt={attempt}
                onLoad={() => setFailure(undefined)}
                onError={() => setFailure("failed")}
                screen={screen}
                compact={compact}
                sizes={
                  zoomed ? width + "px" : "(max-width: 1280px) 95vw, 1280px"
                }
              />
            </div>
            <p>{info.alt}</p>
          </div>
        </dialog>
      )}
    </>
  );
}
