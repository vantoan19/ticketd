// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { PlanList } from "./PlanList";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(cleanup);

function list(archived: boolean) {
  render(
    <PlanList
      plans={[]}
      archived={archived}
      onOpen={() => {}}
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
