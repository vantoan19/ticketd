import { invoke } from "@/lib/api/bridge-failure";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** Set once the app decided to close, so the close guard lets the next request through. */
let quitting = false;

export const windowClient = {
  /** The desktop starts hidden so its stored theme is painted before showing. */
  async show() {
    if (!("__TAURI_INTERNALS__" in window)) return;
    const win = getCurrentWindow();
    await win.show();
    await win.emitTo({ kind: "App" }, "ticketd://startup-revealed");
  },
  /**
   * Holds the window open when the person closes it and calls `handler`, which
   * ends with `quit`. Returns how to stop guarding. Outside the desktop shell
   * there is no window to guard.
   */
  guardClose(handler: () => void): () => void {
    if (!("__TAURI_INTERNALS__" in window)) return () => {};
    let stopped = false;
    let stop: (() => void) | undefined;
    void getCurrentWindow()
      .onCloseRequested((event) => {
        if (quitting) return;
        event.preventDefault();
        // Editors report typing they hold, so drafts are queued before quitting.
        window.dispatchEvent(new Event("ticketd:window-closing"));
        // With Chats working the shell hides the window and nothing is quitting.
        void invoke<boolean>("close_keeps_running")
          .catch(() => false)
          .then((hidden) => {
            if (!hidden) handler();
          });
      })
      .then((unlisten) => {
        if (stopped) unlisten();
        else stop = unlisten;
      })
      .catch(() => {
        // The window closes unguarded.
      });
    return () => {
      stopped = true;
      stop?.();
    };
  },

  /** Closes the window past the guard. */
  async quit() {
    quitting = true;
    const win = getCurrentWindow();
    // An ordinary close passes the guard now, should destroying be refused.
    await win.destroy().catch(() => win.close());
  },

  /**
   * Sets the native title bar and system dialogs to Light or Dark, or back to
   * following the operating system with `null`. Best effort: outside the
   * desktop shell there is no native window to change.
   */
  async setTheme(theme: "light" | "dark" | null) {
    try {
      await getCurrentWindow().setTheme(theme);
    } catch {
      // No native window, or the platform ignores the request.
    }
  },

  /**
   * Paints the window background, which the transparent macOS title bar shows,
   * in the app's canvas color. Best effort, like `setTheme`.
   */
  async setBackgroundColor(color: string) {
    try {
      await getCurrentWebviewWindow().setBackgroundColor(color);
    } catch {
      // No native window, or the platform ignores the request.
    }
  },
};
