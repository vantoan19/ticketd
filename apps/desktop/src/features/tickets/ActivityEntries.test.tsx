// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Activity } from "./Activity";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);
// jsdom lacks the selection APIs CodeMirror needs; a textarea stands in.
vi.mock("@uiw/react-codemirror", () => ({
  default: ({
    value,
    onChange,
    "aria-label": label,
  }: {
    value: string;
    onChange: (value: string) => void;
    "aria-label": string;
  }) => (
    <textarea
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));
afterEach(() => {
  cleanup();
  bridge.invoke.mockReset();
});

const props = {
  status: "Todo",
  revision: 0,
  projects: [],
  active: true,
  trashed: false,
};
const note = {
  id: "n",
  content: "Body",
  created_at: "2026-10-31T10:00:00Z",
  updated_at: "2026-10-31T10:00:00Z",
  editing_agent: "cli-agent",
};

test("shows an editing agent only when one was recorded and words history as sentences", async () => {
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "list_notes")
      return [
        { ...note, id: "agentless", content: "Plain", editing_agent: null },
        { ...note, id: "agent", content: "By agent" },
      ];
    if (command === "ticket_history")
      return [
        {
          kind: "status",
          from_value: "Todo",
          to_value: "In progress",
          timestamp: "2026-10-31T11:00:00Z",
          editing_agent: null,
        },
      ];
    throw new Error(`Unexpected ${command}`);
  });
  render(<Activity {...props} reference="T-20" />);
  await screen.findByText("Status changed from Todo to In progress");
  expect(screen.getAllByText(/^Agent:/)).toHaveLength(1);
  expect(screen.queryByText(/status:/)).toBeNull();
});

test("keeps a note draft when the ticket is left and revisited, until it is discarded", async () => {
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "list_notes" || command === "ticket_history") return [];
    throw new Error(`Unexpected ${command}`);
  });
  const first = render(<Activity {...props} reference="T-21" />);
  fireEvent.click(screen.getByRole("button", { name: "Add a note" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Edit Markdown source" }),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "New note source" }), {
    target: { value: "Half-written finding" },
  });
  first.unmount();
  render(<Activity {...props} reference="T-22" />);
  expect(screen.getByRole("button", { name: "Add a note" })).toBeTruthy();
  cleanup();
  render(<Activity {...props} reference="T-21" />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Edit Markdown source" }),
  );
  expect(
    screen.getByRole("textbox", { name: "New note source" }),
  ).toHaveProperty("value", "Half-written finding");
  fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
  expect(screen.getByRole("button", { name: "Add a note" })).toBeTruthy();
  cleanup();
  render(<Activity {...props} reference="T-21" />);
  expect(screen.getByRole("button", { name: "Add a note" })).toBeTruthy();
});
