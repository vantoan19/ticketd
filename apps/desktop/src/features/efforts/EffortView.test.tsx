// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "@/app/App";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver = ResizeObserverStub;
Object.defineProperty(window, "matchMedia", {
  value: () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }),
});

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);

type Fake = { id: string; reference: string; status: string; effort: string };
let efforts: { id: string; name: string; archived: boolean }[] = [];
let tickets: Fake[] = [];
const calls: [string, unknown][] = [];

const ticket = (item: Fake) => ({
  id: item.id,
  reference: item.reference,
  title: `Title of ${item.reference}`,
  body: "",
  status: item.status,
  trashed: false,
  tags: [] as string[],
  project_id: null,
  effort_id: item.effort || null,
  availability: null,
  prerequisites: [],
  parent: null,
  children: [],
});

beforeEach(() => {
  efforts = [{ id: "e1", name: "Launch", archived: false }];
  tickets = [
    { id: "1", reference: "T-1", status: "Todo", effort: "e1" },
    { id: "2", reference: "T-2", status: "Done", effort: "e1" },
    { id: "3", reference: "T-3", status: "Todo", effort: "" },
  ];
  calls.length = 0;
  bridge.invoke.mockImplementation(async (command: string, args: never) => {
    const input = args as Record<string, never> | undefined;
    calls.push([command, input]);
    switch (command) {
      case "list_efforts":
        return efforts;
      case "show_effort": {
        const members = tickets.filter((item) => item.effort === input?.id);
        const count = (status: string) =>
          members.filter((item) => item.status === status).length;
        return {
          effort: efforts.find((item) => item.id === input?.id),
          members: members.map(ticket),
          counts: {
            todo: count("Todo"),
            in_progress: count("In progress"),
            in_review: count("In review"),
            done: count("Done"),
            canceled: count("Canceled"),
          },
        };
      }
      case "find_tickets": {
        const effort = (input?.filter as unknown as { effort: string | null })
          .effort;
        return tickets
          .filter((item) => !effort || item.effort === effort)
          .map(ticket);
      }
      case "set_effort": {
        const target = tickets.find(
          (item) => item.reference === input?.reference,
        );
        if (target)
          target.effort = (input?.effort as unknown as string | null) ?? "";
        return target ? ticket(target) : null;
      }
      case "change_effort": {
        const target = efforts.find((item) => item.id === input?.id);
        if (target) {
          if (input?.name) target.name = input.name;
          if (input?.archived !== null && input?.archived !== undefined)
            target.archived = input.archived;
        }
        return target;
      }
      case "change_token":
        return 1;
      case "list_projects":
        return [];
      default:
        return [];
    }
  });
});
afterEach(() => {
  cleanup();
  bridge.invoke.mockReset();
});

async function openLaunch() {
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Launch" }));
  return screen.findByRole("heading", { name: "Launch" });
}
test("shows status counts and members for the Effort, and updates both when a member is removed", async () => {
  await openLaunch();
  const group = await screen.findByLabelText("Tickets by status");
  await waitFor(() => expect(group.textContent).toContain("Done1"));
  expect(group.textContent).toContain("Todo1");
  expect(screen.getByText("Effort · 2 tickets")).toBeTruthy();
  expect(screen.getByText("Active")).toBeTruthy();

  fireEvent.click(
    screen.getByRole("button", { name: "Remove T-1 from Launch" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: /^T-1/ })).toBeNull(),
  );
  await waitFor(() =>
    expect(screen.getByText("Effort · 1 ticket")).toBeTruthy(),
  );
  expect(calls).toContainEqual([
    "set_effort",
    { reference: "T-1", effort: null },
  ]);
  expect(screen.getByLabelText("Tickets by status").textContent).toContain(
    "Todo0",
  );
});

test("an empty name shows an inline error and changes nothing", async () => {
  await openLaunch();
  fireEvent.click(screen.getByRole("button", { name: "Rename" }));
  fireEvent.change(screen.getByLabelText("Effort name"), {
    target: { value: "   " },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save name" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Enter a name",
  );
  expect(calls.some(([command]) => command === "change_effort")).toBe(false);
  expect(screen.getByRole("heading", { name: "Launch" })).toBeTruthy();
});

test("renames the Effort", async () => {
  await openLaunch();
  fireEvent.click(screen.getByRole("button", { name: "Rename" }));
  fireEvent.change(screen.getByLabelText("Effort name"), {
    target: { value: "Release" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save name" }));
  await screen.findByRole("heading", { name: "Release" });
  expect(calls).toContainEqual([
    "change_effort",
    { id: "e1", name: "Release", archived: null },
  ]);
});

test("archiving moves the Effort to Archived, where it can be reactivated", async () => {
  await openLaunch();
  expect(screen.getByText(/Archiving hides this Effort/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Archive" }));
  await screen.findByText("Archived", { selector: ".effort-state" });
  await waitFor(() =>
    expect(
      within(
        screen.getByRole("navigation", { name: "Effort scopes" }),
      ).queryByRole("button", { name: "Launch" }),
    ).toBeNull(),
  );
  expect(tickets.map((item) => item.status)).toEqual(["Todo", "Done", "Todo"]);

  fireEvent.click(screen.getByRole("button", { name: /^Archived/ }));
  await screen.findByRole("heading", { name: "Archived Efforts" });
  fireEvent.click(screen.getByRole("button", { name: "Reactivate Launch" }));
  await waitFor(() =>
    expect(
      within(
        screen.getByRole("navigation", { name: "Effort scopes" }),
      ).getByRole("button", { name: "Launch" }),
    ).toBeTruthy(),
  );
});

test("adds an existing ticket from search", async () => {
  await openLaunch();
  fireEvent.click(screen.getByRole("button", { name: "Add tickets" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Add T-3 to Launch" }),
  );
  await waitFor(() =>
    expect(calls).toContainEqual([
      "set_effort",
      { reference: "T-3", effort: "e1" },
    ]),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Add T-3 to Launch" }),
    ).toBeNull(),
  );
});
