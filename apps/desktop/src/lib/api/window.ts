import { getCurrentWindow } from "@tauri-apps/api/window";

export const windowClient = {
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
      await getCurrentWindow().setBackgroundColor(color);
    } catch {
      // No native window, or the platform ignores the request.
    }
  },
};
