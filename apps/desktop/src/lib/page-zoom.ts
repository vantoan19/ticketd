import { getCurrentWebview } from "@tauri-apps/api/webview";

// Page zoom is a window-lifetime view choice, never workspace data.
let appliedFactor = 1;

export function pageZoomFactor() {
  return appliedFactor;
}

export async function setPageZoom(percent: number) {
  if (!("__TAURI_INTERNALS__" in window))
    throw new Error("Page zoom requires the ticketd desktop app.");
  await getCurrentWebview().setZoom(percent / 100);
  appliedFactor = percent / 100;
}
