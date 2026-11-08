import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Minus, Square, X } from "lucide-react";

/**
 * The title bar, drawn by the app where the platform's own bar is turned off
 * (Windows: tauri.windows.conf.json). It is the window's drag handle, and
 * double-clicking it maximizes, as a native bar does; minimize, maximize and
 * close sit at its end. Elsewhere the native bar stays and this renders nothing.
 */
export function WindowBar() {
  const [shown, setShown] = useState(false);
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    const win = getCurrentWindow();
    let active = true;
    let unlisten: (() => void) | undefined;
    const sync = () =>
      void win.isMaximized().then((value) => {
        if (active) setMaximized(value);
      });
    void win
      .isDecorated()
      .then((decorated) => {
        if (!active || decorated) return;
        setShown(true);
        document.documentElement.dataset.windowBar = "";
        sync();
        return win.onResized(sync).then((stop) => {
          if (active) unlisten = stop;
          else stop();
        });
      })
      .catch(() => {
        // No native window to ask: keep whatever bar the platform draws.
      });
    return () => {
      active = false;
      unlisten?.();
      delete document.documentElement.dataset.windowBar;
    };
  }, []);
  if (!shown) return null;
  const win = getCurrentWindow();
  return (
    <div className="window-bar" data-tauri-drag-region>
      <div className="window-controls">
        <button
          type="button"
          aria-label="Minimize"
          title="Minimize"
          onClick={() => void win.minimize()}
        >
          <Minus aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={maximized ? "Restore" : "Maximize"}
          title={maximized ? "Restore" : "Maximize"}
          onClick={() => void win.toggleMaximize()}
        >
          {maximized ? (
            <Copy aria-hidden="true" />
          ) : (
            <Square aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          aria-label="Close"
          title="Close"
          data-close=""
          onClick={() => void win.close()}
        >
          <X aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
