// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Efforts } from "./Efforts";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);
afterEach(() => {
  cleanup();
  bridge.invoke.mockReset();
});

test("preserves a failed Effort rename and shows its error beside the form", async () => {
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "list_efforts")
      return [{ id: "e1", name: "Launch", archived: false }];
    if (command === "show_effort")
      return {
        effort: { id: "e1", name: "Launch", archived: false },
        counts: { todo: 1, in_progress: 0, in_review: 0, done: 0, canceled: 0 },
        members: [],
      };
    if (command === "change_effort") throw new Error("Name already exists");
    throw new Error(`unexpected ${command}`);
  });
  render(<Efforts revision={0} refresh={async () => {}} />);
  await waitFor(() =>
    expect(screen.getByRole("option", { name: "Launch" })).toBeTruthy(),
  );
  fireEvent.change(screen.getByLabelText("View Effort"), {
    target: { value: "e1" },
  });
  await screen.findByLabelText("Name");
  fireEvent.change(screen.getByLabelText("Name"), {
    target: { value: "Draft name" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Rename" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Name already exists",
  );
  expect(screen.getByLabelText("Name")).toHaveProperty("value", "Draft name");
  expect(screen.getByRole("alert").closest("form")).toBeTruthy();
});
