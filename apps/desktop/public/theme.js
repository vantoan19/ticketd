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
})();
