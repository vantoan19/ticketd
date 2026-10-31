// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Activity } from "./Activity";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);
afterEach(() => {
  cleanup();
  bridge.invoke.mockReset();
});

test("preserves a note draft on a failed save and prevents repeated submissions", async () => {
  let rejectSave: (reason: Error) => void = () => {};
  bridge.invoke.mockImplementation((command: string) => {
    if (command === "ticket_history" || command === "list_notes")
      return Promise.resolve([]);
    return new Promise((_resolve, reject) => {
      rejectSave = reject;
    });
  });
  render(
    <Activity
      reference="T-1"
      status="Todo"
      revision={0}
      projects={[]}
      active
      trashed={false}
    />,
  );
  const composer = screen.getByLabelText("New note");
  fireEvent.change(composer, { target: { value: "A **draft**" } });
  fireEvent.click(screen.getByRole("button", { name: "Add note" }));
  expect(
    screen.getByRole("button", { name: "Saving…" }).hasAttribute("disabled"),
  ).toBe(true);
  rejectSave(new Error("Database busy"));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain("Database busy"),
  );
  expect((composer as HTMLTextAreaElement).value).toBe("A **draft**");
  expect(
    bridge.invoke.mock.calls.filter(([command]) => command === "add_note"),
  ).toHaveLength(1);
});

test("opens the selected note even when it is outside the loaded page", async () => {
  bridge.invoke.mockImplementation((command: string) => {
    if (command === "get_note")
      return Promise.resolve({
        id: "older",
        content: "Edited finding",
        created_at: "2026-01-01",
        updated_at: "2026-01-02",
        editing_agent: null,
      });
    if (command === "ticket_history" || command === "list_notes")
      return Promise.resolve([]);
    throw new Error(`Unexpected command: ${command}`);
  });
  render(
    <Activity
      reference="T-1"
      status="Todo"
      revision={0}
      projects={[]}
      active
      trashed={false}
      target={{ id: "older", key: 1 }}
    />,
  );
  expect((await screen.findByLabelText("Selected note")).textContent).toContain(
    "Edited finding",
  );
});
