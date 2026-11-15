// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { StatusLineRegion } from "@/components/ui/status-line";
import { PlanList } from "./PlanList";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);
afterEach(() => {
  cleanup();
  bridge.invoke.mockReset();
});

const counts = {
  total: 6,
  todo: 2,
  in_progress: 0,
  in_review: 0,
  done: 3,
  canceled: 1,
  duplicate: 0,
};

function list(
  archived: boolean,
  plans: {
    id: string;
    name: string;
    archived: boolean;
    purpose: string;
  }[] = [],
  props: Partial<Parameters<typeof PlanList>[0]> = {},
) {
  render(
    <StatusLineRegion>
      <PlanList
        plans={plans}
        archived={archived}
        onOpen={() => {}}
        onArchivedChange={() => {}}
        refresh={async () => {}}
        {...props}
      />
    </StatusLineRegion>,
  );
}

test("an empty Plans list explains itself and leaves New Plan to the header", () => {
  list(false);
  expect(screen.getByText("No Plans yet")).toBeTruthy();
  expect(
    screen.getByText("A Plan groups the tickets that ship together."),
  ).toBeTruthy();
  // P9 action rule: the header already holds the one way to fill the page.
  expect(screen.getAllByRole("button", { name: /New Plan/ })).toHaveLength(1);
});

test("an empty archive says what lands there", () => {
  list(true);
  expect(screen.getByText("No archived Plans")).toBeTruthy();
  expect(screen.getByText("Plans you archive wait here.")).toBeTruthy();
});

test("Active and Archived are one segmented choice on the Plans page", () => {
  const change = vi.fn();
  list(false, [], { onArchivedChange: change });
  fireEvent.click(screen.getByRole("radio", { name: "Archived" }));
  expect(change).toHaveBeenCalledWith(true);
});

test("rows show each Plan's progress, leaving out Canceled tickets", async () => {
  bridge.invoke.mockImplementation(async (command: string) =>
    command === "count_tickets" ? counts : null,
  );
  list(false, [{ id: "p", name: "Launch", archived: false, purpose: "" }]);
  const rows = screen.getByRole("list", { name: "Active Plans" });
  expect(await within(rows).findByText("3 of 5 done")).toBeTruthy();
  expect(
    within(rows).getByRole("progressbar", { name: "Launch progress" }),
  ).toBeTruthy();
});

test("New Plan names the Plan in a dialog, then opens it", async () => {
  bridge.invoke.mockImplementation(async (command: string) =>
    command === "create_plan"
      ? { id: "new", name: "Docs", archived: false, purpose: "" }
      : null,
  );
  const open = vi.fn();
  list(false, [], { onOpen: open });
  fireEvent.click(screen.getByRole("button", { name: /New Plan/ }));
  const dialog = await screen.findByRole("dialog", { name: "New Plan" });
  const create = within(dialog).getByRole("button", { name: "Create Plan" });
  expect((create as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(within(dialog).getByLabelText("Name"), {
    target: { value: "Docs" },
  });
  fireEvent.click(create);
  await waitFor(() => expect(open).toHaveBeenCalledWith("new"));
  expect(bridge.invoke).toHaveBeenCalledWith("create_plan", { name: "Docs" });
});

test("reactivating an archived Plan says so and offers Undo", async () => {
  bridge.invoke.mockResolvedValue(null);
  list(true, [{ id: "p", name: "Launch", archived: true, purpose: "" }]);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Reactivate Launch" }));
  });
  expect(screen.getByRole("status").textContent).toContain(
    "Reactivated Launch",
  );
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  });
  expect(bridge.invoke).toHaveBeenCalledWith("change_plan", {
    id: "p",
    name: null,
    archived: true,
  });
});
