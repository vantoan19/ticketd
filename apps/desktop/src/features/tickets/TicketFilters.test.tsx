// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { ComponentProps } from "react";
import { TicketFilters } from "./TicketFilters";

vi.mock("@/lib/api/client", () => ({
  client: { searchTags: vi.fn(async () => ["bug", "ui"]) },
}));

afterEach(cleanup);

function props(
  overrides: Partial<ComponentProps<typeof TicketFilters>> = {},
): ComponentProps<typeof TicketFilters> {
  return {
    query: "",
    setQuery: vi.fn(),
    plan: "",
    setPlan: vi.fn(),
    status: "",
    setStatus: vi.fn(),
    tags: "",
    setTags: vi.fn(),
    availability: "",
    setAvailability: vi.fn(),
    family: "",
    setFamily: vi.fn(),
    plans: [],
    resetPaging: vi.fn(),
    navigation: { kind: "all", project: "all", plan: "" },
    clearFilters: vi.fn(),
    scopeName: "All tickets",
    total: 7,
    scopeTotal: null,
    ...overrides,
  };
}

test("ticket controls expose Filters and leave search to the palette", () => {
  render(<TicketFilters part="controls" {...props()} />);
  expect(screen.getByRole("button", { name: "Filters" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Search tickets" })).toBeNull();
});

test("Filters opens as a menu with focus on its first dimension, never on a clear action (list F-02)", async () => {
  const p = props();
  render(<TicketFilters part="controls" {...p} />);
  fireEvent.keyDown(screen.getByRole("button", { name: "Filters" }), {
    key: "Enter",
  });
  await act(async () => {});
  const menu = screen.getByRole("menu", { name: /^Filters/ });
  expect(menu).toBeTruthy();
  expect(document.activeElement?.textContent).toContain("Status");
  // Enter on the focused row opens its submenu; nothing is cleared.
  fireEvent.keyDown(document.activeElement!, { key: "Enter" });
  await act(async () => {});
  expect(p.clearFilters).not.toHaveBeenCalled();
  expect(p.setQuery).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("menuitemradio", { name: /In review/ }));
  expect(p.setStatus).toHaveBeenCalledWith("In review");
});

test("tags check in their submenu and stay one chip for the dimension", async () => {
  const setTags = vi.fn();
  render(<TicketFilters part="controls" {...props({ setTags })} />);
  fireEvent.keyDown(screen.getByRole("button", { name: "Filters" }), {
    key: "Enter",
  });
  await act(async () => {});
  fireEvent.keyDown(screen.getByRole("menuitem", { name: /Tags/ }), {
    key: "ArrowRight",
  });
  await act(async () => {});
  fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "ui" }));
  expect(setTags).not.toHaveBeenCalled();
  for (
    let tries = 0;
    tries < 3 && screen.queryAllByRole("menu").length;
    tries++
  ) {
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    await act(async () => {});
  }
  expect(setTags).toHaveBeenCalledWith("ui");
  cleanup();

  render(<TicketFilters part="chips" {...props({ tags: "bug, ui" })} />);
  const chips = screen.getByLabelText("Active filters");
  expect(chips.textContent).toContain("Tagsbug, ui");
  expect(
    screen.getAllByRole("button", { name: /^Remove Tags filter$/ }),
  ).toHaveLength(1);
});

test("Clear filters clears the filters only; the search keeps its own chip (list F-09)", () => {
  const p = props({ query: "capture", status: "Todo" });
  render(<TicketFilters part="chips" {...p} />);
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  expect(p.clearFilters).toHaveBeenCalled();
  expect(p.setQuery).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Remove Search: capture" }),
  );
  expect(p.setQuery).toHaveBeenCalledWith("");
});

test("a search alone offers no Clear filters", () => {
  render(<TicketFilters part="chips" {...props({ query: "capture" })} />);
  expect(screen.getByLabelText("Active filters")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
});
