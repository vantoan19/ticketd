// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { TicketFilters } from "./TicketFilters";

afterEach(cleanup);
test("Search and Filters start as named icon buttons and search opens on demand", () => {
  const setQuery = vi.fn();
  render(
    <TicketFilters
      query=""
      setQuery={setQuery}
      plan=""
      setPlan={vi.fn()}
      status=""
      setStatus={vi.fn()}
      tags=""
      setTags={vi.fn()}
      availability=""
      setAvailability={vi.fn()}
      family=""
      setFamily={vi.fn()}
      plans={[]}
      setOffset={vi.fn()}
      navigation={{ kind: "all", project: "all", plan: "" }}
      clearFilters={vi.fn()}
      scopeName="All tickets"
      total={7}
      scopeTotal={null}
    />,
  );
  expect(screen.queryByRole("textbox", { name: "Search tickets" })).toBeNull();
  expect(screen.getByRole("button", { name: "Filters" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Search tickets" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Search tickets" }), {
    target: { value: "cache" },
  });
  expect(setQuery).toHaveBeenCalledWith("cache");
  expect(screen.getByRole("search")).toBeTruthy();
  expect(screen.queryByLabelText("Active filters")).toBeNull();
});

test("an active search shows as a removable chip", () => {
  const setQuery = vi.fn();
  render(
    <TicketFilters
      part="chips"
      query="capture"
      setQuery={setQuery}
      plan=""
      setPlan={vi.fn()}
      status=""
      setStatus={vi.fn()}
      tags=""
      setTags={vi.fn()}
      availability=""
      setAvailability={vi.fn()}
      family=""
      setFamily={vi.fn()}
      plans={[]}
      setOffset={vi.fn()}
      navigation={{ kind: "all", project: "all", plan: "" }}
      clearFilters={vi.fn()}
      scopeName="All tickets"
      total={1}
      scopeTotal={7}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Remove Search: capture" }),
  );
  expect(setQuery).toHaveBeenCalledWith("");
  expect(screen.getByRole("button", { name: "Clear filters" })).toBeTruthy();
});
