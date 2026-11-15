import { act, fireEvent, screen } from "@testing-library/react";

/**
 * Chooses a value in the list's Filters menu the way a keyboard does: open
 * the menu, open the dimension's submenu, pick the row, then close what is
 * still open (a checkbox row keeps its menu open).
 */
export async function chooseFilter(dimension: string, value: string) {
  const flush = () => act(async () => {});
  if (!screen.queryByRole("button", { name: /^Filters/ })) {
    fireEvent.keyDown(screen.getByRole("button", { name: "Plan actions" }), {
      key: "Enter",
    });
    await flush();
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Filter and display…" }),
    );
    await flush();
  }
  fireEvent.keyDown(screen.getByRole("button", { name: /^Filters/ }), {
    key: "Enter",
  });
  await flush();
  fireEvent.keyDown(
    screen.getByRole("menuitem", { name: new RegExp(`^${dimension}`) }),
    { key: "ArrowRight" },
  );
  await flush();
  const rows = [
    ...screen.queryAllByRole("menuitemradio"),
    ...screen.queryAllByRole("menuitemcheckbox"),
  ];
  const row = rows.find((item) =>
    new RegExp(`^${value}(\\d*)$`).test(item.textContent?.trim() ?? ""),
  );
  if (!row) throw new Error(`No ${dimension} filter row named ${value}`);
  fireEvent.click(row);
  await flush();
  // A checkbox row keeps the menus open: Escape closes each one in turn.
  for (
    let tries = 0;
    tries < 3 && screen.queryAllByRole("menu").length;
    tries++
  ) {
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    await flush();
  }
}
