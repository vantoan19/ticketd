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
      effort=""
      setEffort={vi.fn()}
      status=""
      setStatus={vi.fn()}
      tags=""
      setTags={vi.fn()}
      availability=""
      setAvailability={vi.fn()}
      family=""
      setFamily={vi.fn()}
      efforts={[]}
      setOffset={vi.fn()}
      navigation={{ kind: "all", project: "all", effort: "" }}
      clearFilters={vi.fn()}
    />,
  );
  expect(screen.queryByRole("textbox", { name: "Search tickets" })).toBeNull();
  expect(screen.getByRole("button", { name: "Filters" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Search tickets" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Search tickets" }), {
    target: { value: "cache" },
  });
  expect(setQuery).toHaveBeenCalledWith("cache");
  expect(screen.queryByLabelText("Active filters")).toBeNull();
});
