// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { PlanList } from "./PlanList";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(cleanup);

function list(archived: boolean, onBrowsePlans = () => {}) {
  render(
    <PlanList
      plans={[]}
      archived={archived}
      onOpen={() => {}}
      onBrowsePlans={onBrowsePlans}
      refresh={async () => {}}
    />,
  );
}

test("an empty Plans list explains itself with the shared empty state", () => {
  list(false);
  expect(screen.getByText("No Plans yet")).toBeTruthy();
  expect(screen.getByText(/groups tickets toward one goal/)).toBeTruthy();
});

test("an empty archive says what lands there", () => {
  list(true);
  expect(screen.getByText("No archived Plans")).toBeTruthy();
  expect(screen.getByText(/kept here, read-only/)).toBeTruthy();
});

test("an empty archive offers a way back to Plans", () => {
  const back = vi.fn();
  list(true, back);
  fireEvent.click(screen.getByRole("button", { name: "Back to Plans" }));
  expect(back).toHaveBeenCalled();
});

test("an empty Plans list offers the action that fills it", () => {
  list(false);
  fireEvent.click(screen.getByRole("button", { name: "Name a Plan" }));
  expect(document.activeElement).toBe(screen.getByLabelText("New Plan name"));
});
