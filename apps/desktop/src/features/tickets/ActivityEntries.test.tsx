// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
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
// The composer's editor loads lazily. Load it once up front so no test waits on the
// import, which is slow when many test files start together.
beforeAll(async () => {
  await import("@/features/markdown/MarkdownEditor");
});
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
  render(<Activity {...props} reference="T-KQ20" />);
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
  render(<Activity {...props} reference="T-KQ20" />);
  await screen.findByText("Status Todo → In progress");
  expect(screen.queryByText(/Only in ticketd/)).toBeNull();
  // The agent names its update; an agentless one is the person's own.
  expect(screen.getAllByRole("article")).toHaveLength(2);
  expect(screen.getAllByText("You")).toHaveLength(1);
  expect(screen.queryByText(/status:/)).toBeNull();
});

test("keeps a note draft when the ticket is left and revisited, until it is discarded", async () => {
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "activity_feed" || command === "ticket_history") return [];
    throw new Error(`Unexpected ${command}`);
  });
  const first = render(<Activity {...props} reference="T-KQ21" />);
  fireEvent.click(screen.getByRole("button", { name: "Write an update…" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Edit Markdown source" }),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "New update source" }), {
    target: { value: "Half-written finding" },
  });
  first.unmount();
  render(<Activity {...props} reference="T-KQ22" />);
  expect(screen.getByRole("button", { name: "Write an update…" })).toBeTruthy();
  cleanup();
  render(<Activity {...props} reference="T-KQ21" />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Edit Markdown source" }),
  );
  expect(
    screen.getByRole("textbox", { name: "New update source" }),
  ).toHaveProperty("value", "Half-written finding");
  fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
  expect(screen.getByRole("button", { name: "Write an update…" })).toBeTruthy();
  cleanup();
  render(<Activity {...props} reference="T-KQ21" />);
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
      reference="T-KQ50"
      sourceName="GitHub"
      latestNoteId="n"
    />,
  );
  const body = await screen.findByText("Body");
  expect(screen.getByRole("heading", { name: /^Activity/ })).toBeTruthy();
  expect(
    screen.getByText("Only in ticketd · never sent to GitHub"),
  ).toBeTruthy();
  expect(screen.getByText("Latest")).toBeTruthy();
  expect(screen.getByText("2 h ago")).toBeTruthy();
  expect(
    screen
      .getByRole("button", { name: "Write an update…" })
      .compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

test("an empty composer offers Cancel and says why Post is disabled", async () => {
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "activity_feed" || command === "ticket_history") return [];
    throw new Error(`Unexpected ${command}`);
  });
  render(<Activity {...props} reference="T-KQ23" />);
  fireEvent.click(screen.getByRole("button", { name: "Write an update…" }));
  expect(screen.queryByRole("button", { name: "Discard draft" })).toBeNull();
  expect(screen.getByText("Write an update to post.")).toBeTruthy();
  expect(
    screen
      .getByRole("button", { name: "Post update" })
      .hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("button", { name: "Write an update…" })).toBeTruthy();
});

test("Reply starts a new update with a quote of the one it answers", async () => {
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "activity_feed")
      return [
        {
          type: "authored",
          activity: {
            ...note,
            brief: "Found the cause. More detail follows.",
            editing_agent: null,
          },
        },
      ];
    if (command === "ticket_history") return [];
    throw new Error(`Unexpected ${command}`);
  });
  render(<Activity {...props} reference="T-KQ24" />);
  await screen.findByText("Found the cause. More detail follows.");
  fireEvent.pointerDown(
    screen.getByRole("button", { name: /Actions for update from/ }),
    { button: 0, ctrlKey: false },
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: "Reply" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Edit Markdown source" }),
  );
  expect(
    screen.getByRole("textbox", { name: "New update source" }),
  ).toHaveProperty("value", expect.stringContaining("> Re: Found the cause"));
});

test("changes made together share one row, and Updates hides the rows", async () => {
  const added = (name: string, id: number) => ({
    type: "automatic",
    id,
    event: {
      kind: "evidence",
      from_value: "",
      to_value: name,
      timestamp: "2026-10-31T11:00:00Z",
      editing_agent: "codex",
    },
  });
  bridge.invoke.mockImplementation(async (command: string) =>
    command === "activity_feed"
      ? [
          added("PR #482", 1),
          added("fix branch", 2),
          { type: "authored", activity: note },
        ]
      : [],
  );
  render(<Activity {...props} reference="T-KQ21" />);
  await screen.findByText("Added evidence “PR #482” and “fix branch”");
  fireEvent.click(screen.getByRole("radio", { name: "Updates" }));
  expect(screen.queryByText(/Added evidence/)).toBeNull();
  expect(screen.getByText("Body")).toBeTruthy();
});

test("says no updates, not no activity, when the Updates filter hides only history (DB-21)", async () => {
  bridge.invoke.mockImplementation(async (command: string) =>
    command === "activity_feed"
      ? [
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
        ]
      : [],
  );
  render(<Activity {...props} reference="T-KQ60" />);
  await screen.findByText("Status Todo → In progress");
  fireEvent.click(screen.getByRole("radio", { name: "Updates" }));
  expect(screen.getByText("No updates yet.")).toBeTruthy();
  expect(screen.queryByText(/No updates or recorded changes/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show all activity" }));
  expect(await screen.findByText("Status Todo → In progress")).toBeTruthy();
});

test("offers only what can be added instead of a disabled button with a hidden reason (DB-07)", async () => {
  bridge.invoke.mockImplementation(async (command: string) =>
    command === "show_document"
      ? {
          id: "doc-1",
          title: "Investigation",
          body: "",
          created_at: "2026-01-01",
          updated_at: "2026-01-01",
          trashed: false,
        }
      : [],
  );
  localStorage.setItem(
    "ticketd:activity-draft:T-KQ61",
    JSON.stringify({ brief: "Brief", details: null, support: "doc-1" }),
  );
  render(<Activity {...props} reference="T-KQ61" />);
  expect(await screen.findByText("Investigation")).toBeTruthy();
  // With a Document attached, details can't be added: the + is gone, not disabled.
  expect(
    screen.queryByRole("button", { name: "Add details or a Document" }),
  ).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Remove attached Document" }),
  );
  expect(
    screen.getByRole("button", { name: "Add details or a Document" }),
  ).toHaveProperty("disabled", false);
  localStorage.clear();
});
