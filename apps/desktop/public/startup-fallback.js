// Evaluated by the native watchdog even when application modules never load.
// React replaces the initial root contents once it renders successfully.
(() => {
  const failure = globalThis.document.getElementById("startup-failure");
  if (!failure) return;
  const dark = globalThis.document.documentElement.dataset.theme === "dark";
  // Application CSS may be missing too. These are the canvas/foreground tokens
  // from styles.css, scoped to the fallback so a later render removes them.
  Object.assign(failure.style, {
    position: "fixed",
    inset: "0",
    padding: "24px",
    backgroundColor: dark ? "#0A0A0A" : "#FAFAFA",
    color: dark ? "#EDEDED" : "#171717",
  });
  failure.removeAttribute("hidden");
})();
