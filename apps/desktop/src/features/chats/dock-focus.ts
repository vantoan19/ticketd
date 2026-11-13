/** The choices of the request in `root`, in order: what ↑/↓ and 1–9 move through. */
export const requestChoices = (root: HTMLElement) => [
  ...root.querySelectorAll<HTMLButtonElement>("[data-choice]"),
];

/** Focuses the last choice of the request in the dock; false when there is none. */
export function focusLastChoice(dock: HTMLElement | null) {
  const last = dock ? requestChoices(dock).at(-1) : undefined;
  last?.focus();
  return Boolean(last);
}
