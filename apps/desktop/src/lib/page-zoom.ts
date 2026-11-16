import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";

export const pageZoomLevels = [
  50, 67, 75, 90, 100, 110, 125, 150, 175, 200,
] as const;
const storageKey = "ticketd.page-zoom";
let confirmedFactor = 1;

// sessionStorage belongs to this webview and survives its reload, unlike module
// state. A new window starts fresh; zoom is never a workspace preference.
function savedPercent(): number | null {
  try {
    const value = Number(sessionStorage.getItem(storageKey));
    return pageZoomLevels.find((level) => level === value) ?? null;
  } catch {
    return null;
  }
}

function remember(percent: number) {
  confirmedFactor = percent / 100;
  try {
    sessionStorage.setItem(storageKey, String(percent));
  } catch {
    // Storage may be unavailable; native Reset still always issues a request.
  }
}

export function pageZoomPercent() {
  return "__TAURI_INTERNALS__" in window ? (savedPercent() ?? 100) : 100;
}

export function pageZoomFactor() {
  return (savedPercent() ?? confirmedFactor * 100) / 100;
}

export async function initializePageZoom() {
  const saved = savedPercent();
  if (!("__TAURI_INTERNALS__" in window)) return 100;
  if (saved !== null) {
    confirmedFactor = saved / 100;
    return saved;
  }
  // The installed SDK has a setter, but no zoom getter. Both WebKit and
  // WebView2 include page zoom in DPR; native scaleFactor is display scale.
  // Recover a retained native zoom on the first reload after this fix too.
  try {
    const scale = await getCurrentWindow().scaleFactor();
    const measured = (window.devicePixelRatio / scale) * 100;
    const percent = pageZoomLevels.find(
      (level) => Math.abs(level - measured) < 1,
    );
    if (percent !== undefined) {
      remember(percent);
      return percent;
    }
  } catch {
    // Best effort when native window measurements are unavailable.
  }
  return 100;
}

export async function setPageZoom(percent: number) {
  if (!("__TAURI_INTERNALS__" in window))
    throw new Error("Page zoom requires the ticketd desktop app.");
  await getCurrentWebview().setZoom(percent / 100);
  remember(percent);
}
