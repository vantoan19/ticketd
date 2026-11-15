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
  expect(
    screen.getByText("A Plan groups the tickets that ship together."),
  ).toBeTruthy();
});

test("an empty archive says what lands there", () => {
  list(true);
  expect(screen.getByText("No archived Plans")).toBeTruthy();
  expect(screen.getByText("Plans you archive wait here.")).toBeTruthy();
});

test("an empty archive offers a way back to Plans", () => {
  const back = vi.fn();
  list(true, back);
  fireEvent.click(screen.getByRole("button", { name: "Show active Plans" }));
  expect(back).toHaveBeenCalled();
});

test("an empty Plans list adds no second action beside the create form", () => {
  // P9 action rule: the form above already fills the page.
  list(false);
  expect(screen.getByLabelText("New Plan name")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Name a Plan" })).toBeNull();
});
