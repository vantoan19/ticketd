/** Both libraries move focus first; Enter explicitly opens the focused item. */
export function focusNavigatorRow(
  rows: HTMLButtonElement[],
  current: Element | null,
  key: string,
) {
  const at = rows.indexOf(current as HTMLButtonElement);
  const next =
    key === "Home"
      ? rows[0]
      : key === "End"
        ? rows.at(-1)
        : rows[
            at + (key === "ArrowDown" || key.toLowerCase() === "j" ? 1 : -1)
          ];
  next?.focus();
  next?.scrollIntoView?.({ block: "nearest" });
}
