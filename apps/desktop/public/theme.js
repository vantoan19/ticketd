// Run before module/CSS loading: the webview also starts in its theme.
(() => {
  let theme = "system";
  try {
    theme = JSON.parse(
      globalThis.localStorage.getItem("ticketd.preferences"),
    )?.theme;
  } catch {
    // Unreadable preferences follow the operating system.
  }
  const dark =
    theme === "dark" ||
    (theme !== "light" &&
      globalThis.matchMedia("(prefers-color-scheme: dark)").matches);
  const root = globalThis.document.documentElement;
  root.dataset.theme = dark ? "dark" : "light";
  root.classList.toggle("dark", dark);
  root.style.colorScheme = dark ? "dark" : "light";
  // The watchdog can reveal its fallback before application modules load.
  // Use the existing Tauri window APIs here too so its native frame follows
  // the same theme even if the module graph fails. This never reveals a window;
  // main.tsx does, once these settle (ticketdThemePainted).
  const native = globalThis.__TAURI_INTERNALS__;
  const label = native?.metadata?.currentWindow?.label;
  if (native?.invoke && label) {
    const background = dark ? "#0A0A0A" : "#FAFAFA";
    globalThis.ticketdThemePainted = Promise.allSettled([
      native.invoke("plugin:window|set_theme", {
        label,
        value: theme === "light" || theme === "dark" ? theme : null,
      }),
      native.invoke("plugin:window|set_background_color", {
        label,
        value: background,
      }),
      native.invoke("plugin:webview|set_webview_background_color", {
        label,
        value: background,
      }),
    ]);
  }
})();
