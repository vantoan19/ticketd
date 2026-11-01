// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "@/app/App";
import { bridgeDefault, unknownCommands } from "@/test/bridge-defaults";

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
vi.mock("@/features/tickets/DependencyGraph", () => ({ default: () => null }));
vi.mock("@uiw/react-codemirror", () => ({ default: () => null }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  bridge.invoke.mockReset();
  expect(unknownCommands.splice(0)).toEqual([]);
});

const ticket = {
  id: "1",
  reference: "T-1",
  title: "First",
  body: "",
  status: "Todo",
  trashed: false,
  tags: [],
  project_id: null,
  effort_id: null,
  availability: "Ready",
  prerequisites: [],
  parent: null,
  children: [],
};

/** Open T-1 and return the bridge calls made since the selection settled. */
async function openTicket(token: { value: number }) {
  bridge.invoke.mockImplementation(
    async (command: string, args?: { reference?: string }) => {
      if (command === "change_token") return token.value;
      if (command === "find_tickets") return [ticket];
      if (command === "show_ticket") return ticket;
      return bridgeDefault(command, args);
    },
  );
  vi.useFakeTimers();
  render(<App />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  fireEvent.click(screen.getByRole("button", { name: /First/ }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

const reads = (...commands: string[]) =>
  bridge.invoke.mock.calls.filter(([command]) => commands.includes(command))
    .length;

test("a refresh that finds no workspace change makes no Backlinks or relationship reads", async () => {
  await openTicket({ value: 7 });
  expect(reads("ticket_backlinks")).toBe(1);
  expect(reads("contextual_relationships")).toBe(1);
  const refreshes = reads("find_tickets");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(6000);
  });
  // The list and ticket still refresh; only the two sections are skipped.
  expect(reads("find_tickets")).toBeGreaterThan(refreshes);
  expect(reads("ticket_backlinks")).toBe(1);
  expect(reads("contextual_relationships")).toBe(1);
});

test("a changed workspace makes the next refresh re-read Backlinks and relationships", async () => {
  const token = { value: 7 };
  await openTicket(token);
  token.value = 8; // for instance, the CLI linked or mentioned this ticket
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(reads("ticket_backlinks")).toBe(2);
  expect(reads("contextual_relationships")).toBe(2);
});
