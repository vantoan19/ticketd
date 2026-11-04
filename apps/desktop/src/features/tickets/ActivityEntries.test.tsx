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
  ticket_id: "ticket",
  brief: "Body",
  reported_at: "2026-10-31T10:00:00Z",
  updated_at: "2026-10-31T10:00:00Z",
  editing_agent: "cli-agent",
};

test("a change that came from a source reads as the source, not as an agent", async () => {
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "activity_feed")
      return [
        {
          type: "automatic",
          id: 1,
          event: {
            kind: "status",
            from_value: "Todo",
            to_value: "Canceled",
            timestamp: "2026-10-31T11:00:00Z",
            editing_agent: "github",
          },
        },
      ];
    throw new Error(`Unexpected ${command}`);
  });
  render(<Activity {...props} reference="T-20" />);
  await screen.findByText("Changed on GitHub");
  expect(screen.queryByText(/Agent:/)).toBeNull();
});

test("shows an editing agent only when one was recorded and words history as sentences", async () => {
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "activity_feed")
      return [
        {
          type: "automatic",
          id: 1,
          event: {
            kind: "status",
            from_value: "Todo",
            to_value: "In progress",
            timestamp: "2026-10-31T11:00:00Z",
            editing_agent: null,
          },
        },
        {
          type: "authored",
          activity: {
            ...note,
            id: "agentless",
            brief: "Plain",
            editing_agent: null,
          },
        },
        {
          type: "authored",
          activity: { ...note, id: "agent", brief: "By agent" },
        },
      ];
    throw new Error(`Unexpected ${command}`);
  });
  render(<Activity {...props} reference="T-20" />);
  await screen.findByText("Status changed from Todo to In progress");
  expect(screen.getByText("Only in ticketd")).toBeTruthy();
  expect(screen.getAllByText(/^Agent:/)).toHaveLength(1);
  expect(screen.queryByText(/status:/)).toBeNull();
});

test("keeps a note draft when the ticket is left and revisited, until it is discarded", async () => {
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "activity_feed" || command === "ticket_history") return [];
    throw new Error(`Unexpected ${command}`);
  });
  const first = render(<Activity {...props} reference="T-21" />);
  fireEvent.click(screen.getByRole("button", { name: "Write an update…" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Edit Markdown source" }),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "New update source" }), {
    target: { value: "Half-written finding" },
  });
  first.unmount();
  render(<Activity {...props} reference="T-22" />);
  expect(screen.getByRole("button", { name: "Write an update…" })).toBeTruthy();
  cleanup();
  render(<Activity {...props} reference="T-21" />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Edit Markdown source" }),
  );
  expect(
    screen.getByRole("textbox", { name: "New update source" }),
  ).toHaveProperty("value", "Half-written finding");
  fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
  expect(screen.getByRole("button", { name: "Write an update…" })).toBeTruthy();
  cleanup();
  render(<Activity {...props} reference="T-21" />);
  expect(screen.getByRole("button", { name: "Write an update…" })).toBeTruthy();
});

test("Activity puts the composer before labelled notes and quiet relative history", async () => {
  const recent = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
  bridge.invoke.mockImplementation(async (command: string) =>
    command === "activity_feed"
      ? [{ type: "authored", activity: { ...note, reported_at: recent } }]
      : [],
  );
  render(
    <Activity
      {...props}
      reference="T-50"
      sourceName="GitHub"
      latestNoteId="n"
    />,
  );
  const body = await screen.findByText("Body");
  expect(screen.getByRole("heading", { name: "Activity" })).toBeTruthy();
  expect(
    screen.getByText("Only in ticketd · never sent to GitHub"),
  ).toBeTruthy();
  expect(screen.getByText("Latest update")).toBeTruthy();
  expect(screen.getByText("2 h ago")).toBeTruthy();
  expect(
    screen
      .getByRole("button", { name: "Write an update…" })
      .compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});
