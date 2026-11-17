import { arrive } from "./arrive";

/** How long to wait for the list's rows, which arrive after the first paint. */
const ROWS_WAIT_MS = 1500;
/** The cascade stops after eight steps. */
const ROWS = 5;

/**
 * App launch (DESIGN.md section 12): the sidebar fades in, the content pane
 * fades up a step later, then the list's header and first rows follow in a
 * cascade. Run it when the window opens and after a workspace switch, never
 * when returning to the window. The rows come from a read, so they are caught
 * when they first appear. Returns the function that stops waiting for them.
 */
export function launch(workspace: HTMLElement): () => void {
  const sidebar = workspace.querySelector(".sidebar");
  if (sidebar) arrive(sidebar, { fade: true });
  const panel = workspace.querySelector(".content-panel");
  if (panel) arrive(panel, { index: 1 });
  const header = workspace.querySelector(".ticket-list .ui-pane-header");
  if (header) arrive(header, { index: 2 });

  const rows = () =>
    workspace.querySelectorAll("ul.ticket-rows > li:not([hidden])");
  const cascade = () => {
    let index = 3;
    for (const row of [...rows()].slice(0, ROWS))
      arrive(row, { index: index++ });
  };
  if (rows().length > 0) {
    cascade();
    return () => {};
  }
  const observer = new MutationObserver(() => {
    if (rows().length === 0) return;
    observer.disconnect();
    clearTimeout(giveUp);
    cascade();
  });
  const giveUp = setTimeout(() => observer.disconnect(), ROWS_WAIT_MS);
  observer.observe(workspace, { childList: true, subtree: true });
  return () => {
    observer.disconnect();
    clearTimeout(giveUp);
  };
}
