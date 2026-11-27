/** How long a setting stays highlighted after Search opens its page. */
export const HIGHLIGHT_MS = 3000;
/** How long to wait for a page that is still loading to show the setting. */
const WAIT_MS = 4000;

/** Text as people read it: one case, one kind of quote, one run of spaces. */
function plain(text: string | null) {
  return (text ?? "")
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** The part of a page that names the page, never one of its settings. */
const PAGE_HEADING = ".settings-panel-bar, .settings-page-header";

/** What a setting's title belongs to: its row, its table row, its Support card, or its section. */
const SETTING = ".settings-list-row, tr, .support-card, .settings-section";

/** The text an element holds itself, not in its children: "Chats" in `Chats <Badge>`. */
function ownText(element: Element) {
  return plain(
    Array.from(element.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent)
      .join(""),
  );
}

/**
 * The element a Settings page shows for the setting called `title`, grown to
 * the row, table row or section around it: the innermost element whose text is
 * exactly the title, else the first that holds the title itself beside other
 * elements (a title followed by a badge). Pages that are kept mounted while
 * hidden and the page's own heading never match, so a setting that is the page
 * itself has none.
 */
export function findSetting(root: ParentNode, title: string) {
  const wanted = plain(title);
  const candidates = Array.from(root.querySelectorAll("*")).filter(
    (element) => !element.closest(`[hidden], ${PAGE_HEADING}`),
  );
  let found: Element | null = null;
  for (const element of candidates) {
    if (found && !found.contains(element)) continue;
    if (plain(element.textContent) === wanted) found = element;
  }
  found ??= candidates.find((element) => ownText(element) === wanted) ?? null;
  return found ? (found.closest(SETTING) ?? found) : null;
}

/**
 * Shows the setting called `title` somewhere in `root`: scrolls it into view
 * and marks it `data-found` for `HIGHLIGHT_MS`. A page may still be loading,
 * so a setting that is not there yet is looked for again as the page changes.
 * Returns what undoes it.
 */
export function showSetting(root: HTMLElement, title: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let shown: Element | null = null;
  const look = () => {
    const element = findSetting(root, title);
    if (!element) return false;
    observer.disconnect();
    clearTimeout(giveUp);
    shown = element;
    element.scrollIntoView?.({ block: "center" });
    element.setAttribute("data-found", "");
    timer = setTimeout(
      () => element.removeAttribute("data-found"),
      HIGHLIGHT_MS,
    );
    return true;
  };
  const observer = new MutationObserver(look);
  const giveUp = setTimeout(() => observer.disconnect(), WAIT_MS);
  if (!look()) observer.observe(root, { childList: true, subtree: true });
  return () => {
    observer.disconnect();
    clearTimeout(giveUp);
    clearTimeout(timer);
    shown?.removeAttribute("data-found");
  };
}
