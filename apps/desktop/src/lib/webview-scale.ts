import { pageZoomFactor } from "@/lib/page-zoom";
import { PhysicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";

// Windows: WebView2 can lose track of the display scale or its own bounds,
// most often after the machine wakes from sleep. The UI then draws too small,
// too large, or short of the window until the window is resized
// (tauri-apps/tauri#7142, MicrosoftEdge/WebView2Feedback#3429). This checks the
// page against its window when the window comes back and, if they differ,
// resizes the window by one pixel and back, which makes WebView2 redraw.

type Size = { width: number; height: number };

/** The page's scale and CSS size against the window's scale and physical size. */
export function outOfStep(
  page: { dpr: number } & Size,
  window: { scale: number } & Size,
): boolean {
  if (Math.abs(page.dpr - window.scale) > 0.01) return true;
  // CSS sizes are whole pixels, so allow a rounding of up to one CSS pixel.
  const slack = Math.ceil(page.dpr) + 1;
  return (
    Math.abs(page.width * page.dpr - window.width) > slack ||
    Math.abs(page.height * page.dpr - window.height) > slack
  );
}

type RepairableWindow = {
  isMaximized(): Promise<boolean>;
  innerSize(): Promise<Size>;
  setSize(size: PhysicalSize): Promise<void>;
  unmaximize(): Promise<void>;
  maximize(): Promise<void>;
};

/** A real resize is what makes WebView2 take its scale and bounds again. */
export async function repair(win: RepairableWindow) {
  if (await win.isMaximized()) {
    await win.unmaximize();
    await win.maximize();
    return;
  }
  const { width, height } = await win.innerSize();
  await win.setSize(new PhysicalSize(width + 1, height));
  await win.setSize(new PhysicalSize(width, height));
}

/** Watches the desktop window; does nothing outside the desktop shell. */
export function keepWebviewInStep() {
  if (!("__TAURI_INTERNALS__" in window)) return;
  const win = getCurrentWindow();
  let busy = false;
  let disposed = false;
  const timers = new Set<number>();
  const check = async () => {
    if (disposed || busy || document.visibilityState !== "visible") return;
    busy = true;
    try {
      const [scale, size] = await Promise.all([
        win.scaleFactor(),
        win.innerSize(),
      ]);
      const zoom = pageZoomFactor();
      // WebView2 and WebKit include native page zoom in DPR.
      // Compare the unzoomed page so accessible zoom is not mistaken for the
      // wake-from-sleep display-scale failure this repair addresses.
      const page = {
        dpr: window.devicePixelRatio / zoom,
        width: window.innerWidth * zoom,
        height: window.innerHeight * zoom,
      };
      if (!disposed && outOfStep(page, { scale, ...size })) await repair(win);
    } catch {
      // Best effort: a window that cannot be read or resized is left alone.
    } finally {
      busy = false;
    }
  };
  // Let a scale change or a wake settle before reading the sizes.
  const soon = () => {
    const timer = window.setTimeout(() => {
      timers.delete(timer);
      void check();
    }, 500);
    timers.add(timer);
  };
  window.addEventListener("focus", soon);
  document.addEventListener("visibilitychange", soon);
  const unlisten = win.onScaleChanged(soon).catch(() => undefined);
  soon();
  return () => {
    disposed = true;
    timers.forEach((timer) => window.clearTimeout(timer));
    window.removeEventListener("focus", soon);
    document.removeEventListener("visibilitychange", soon);
    void unlisten.then((stop) => stop?.());
  };
}
