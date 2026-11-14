/** The choices of the request in `root`, in order: what ↑/↓ and 1–9 move through. */
export const requestChoices = (root: HTMLElement) => [
  ...root.querySelectorAll<HTMLButtonElement>("[data-choice]"),
];

/**
 * Focuses the first choice of the request in the dock, the safe default (Allow
 * once before Deny); ↓ moves on through the rest. False when there is none.
 */
export function focusFirstChoice(dock: HTMLElement | null) {
  const first = dock ? requestChoices(dock)[0] : undefined;
  first?.focus();
  return Boolean(first);
}
