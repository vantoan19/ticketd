// @vitest-environment jsdom
import { githubSource } from "@/test/source-fixtures";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import type { ComponentProps } from "react";
import type { ChangeSignal } from "@/lib/workspace-reads";
import { fakeChangeSignal } from "@/lib/workspace-reads/fake-signal";
import { deferred } from "@/lib/workspace-reads/test-support";
import type { Document } from "@/features/documents/api";
import { Activity as ActivitySection } from "./Activity";
import { changeSummary } from "./history-sentence";
import type { Entry } from "@/lib/api/history";
import { OpenTicketFor } from "./open-ticket/parts/activity-testing";

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
// The composer's editor and its source editor load lazily. Load them once up front so no test waits on the
// import, which is slow when many test files start together.
beforeAll(async () => {
  const editor = await import("@/features/markdown/MarkdownEditor");
  await editor.LazySourceEditor.preload();
});
afterEach(() => {
  cleanup();
  localStorage.removeItem("ticketd:activity-view");
  bridge.invoke.mockReset();
});

/** Activity as a section of the open Ticket, as on the page. */
function Activity({
  signal,
  hidden,
  ...props
}: ComponentProps<typeof ActivitySection> & {
  signal?: ChangeSignal;
  hidden?: boolean;
}) {
  return (
    <OpenTicketFor
      reference={props.reference}
      {...(signal && { signal })}
      {...(hidden !== undefined && { hidden })}
    >
      <ActivitySection {...props} />
    </OpenTicketFor>
  );
}

const props = {
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

test("opens on the newest three updates and remembers All for the next ticket", async () => {
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "activity_feed")
      return [5, 4, 3, 2, 1].map((number) => ({
        type: "authored",
        activity: {
          ...note,
          id: String(number),
          brief: `Update ${number}`,
          reported_at: `2026-10-31T1${number}:00:00Z`,
          updated_at: `2026-10-31T1${number}:00:00Z`,
        },
      }));
    throw new Error(`Unexpected ${command}`);
  });
  const first = render(<Activity {...props} reference="T-KQ20" />);
  await screen.findByText("Update 5");
  expect(
    screen.getByRole("radio", { name: "Updates", checked: true }),
  ).toBeTruthy();
  expect(screen.getAllByRole("article").map((row) => row.textContent)).toEqual([
    expect.stringContaining("Update 5"),
    expect.stringContaining("Update 4"),
    expect.stringContaining("Update 3"),
  ]);
  const earlier = screen.getByRole("button", {
    name: "2 earlier updates",
    expanded: false,
  });
  fireEvent.click(earlier);
  expect(await screen.findByText("Update 1")).toBeTruthy();
  expect(earlier.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(screen.getByRole("radio", { name: "All" }));
  first.unmount();
  render(<Activity {...props} reference="T-KQ21" />);
  await screen.findByText("Update 5");
  expect(
    screen.getByRole("radio", { name: "All", checked: true }),
  ).toBeTruthy();
});

test("counts earlier authored updates even when recorded changes fill the All feed", async () => {
  const authored = Array.from({ length: 52 }, (_, index) => ({
    type: "authored",
    activity: { ...note, id: String(index), brief: `Authored update ${index}` },
  }));
  const automated = Array.from({ length: 50 }, (_, index) => ({
    type: "automatic",
    id: index,
    event: {
      kind: "status",
      from_value: "Todo",
      to_value: "In progress",
      timestamp: "2026-10-31T11:00:00Z",
      editing_agent: null,
    },
  }));
  bridge.invoke.mockImplementation(
    async (
      command: string,
      args?: { updatesOnly?: boolean; offset: number },
    ) => {
      if (command === "activity_feed")
        return (args?.updatesOnly ? authored : automated).slice(
          args?.offset ?? 0,
          (args?.offset ?? 0) + 50,
        );
      if (command === "activity_update_count") return 52;
      throw new Error(`Unexpected ${command}`);
    },
  );
  render(<Activity {...props} reference="T-KQ20" />);
  await screen.findByText("Authored update 0");
  const earlier = await screen.findByRole("button", {
    name: "49 earlier updates",
    expanded: false,
  });
  expect(screen.getAllByRole("article")).toHaveLength(3);
  expect(
    screen.queryByRole("button", { name: "Show more activity" }),
  ).toBeNull();
  fireEvent.click(earlier);
  await screen.findByText("Authored update 49");
  await screen.findByText("Authored update 51");
  expect(
    screen.getByRole("button", { name: "49 earlier updates", expanded: true }),
  ).toBe(earlier);
  expect(bridge.invoke).toHaveBeenCalledWith("activity_feed", {
    reference: "T-KQ20",
    offset: 0,
    limit: 50,
    updatesOnly: true,
  });
});

test("Earlier uses the authored feed when the last count is stale", async () => {
  const updates = Array.from({ length: 52 }, (_, index) => ({
    type: "authored",
    activity: { ...note, id: String(index), brief: `Authored update ${index}` },
  }));
  let revised = false;
  bridge.invoke.mockImplementation(
    async (
      command: string,
      args?: { updatesOnly?: boolean; offset: number },
    ) => {
      if (command === "activity_feed" && args?.updatesOnly)
        return updates.slice(
          args.offset,
          Math.min(args.offset + 50, revised ? 52 : 50),
        );
      if (command === "activity_update_count") {
        if (revised) throw new Error("Could not refresh the count");
        return 50;
      }
      throw new Error(`Unexpected ${command}`);
    },
  );
  const laterPage = {
    reference: "T-KQ20",
    offset: 50,
    limit: 50,
    updatesOnly: true,
  };
  const signal = fakeChangeSignal();
  render(<Activity {...props} reference="T-KQ20" signal={signal} />);
  const earlier = await screen.findByRole("button", {
    name: "47 earlier updates",
  });
  // A full page can also be the last one, so let the first count arrive.
  await act(async () => {});
  await act(async () => fireEvent.click(earlier));
  await screen.findByText("Authored update 49");
  expect(bridge.invoke).not.toHaveBeenCalledWith("activity_feed", laterPage);

  revised = true;
  await act(async () => signal.change());
  expect(await screen.findByText("Authored update 51")).toBeTruthy();
  expect(bridge.invoke).toHaveBeenCalledWith("activity_feed", laterPage);
});

test("Earlier reuses detail Document reads until the workspace revision changes", async () => {
  const detailIds = new Map([
    [0, "current"],
    [1, "pending"],
    [50, "earlier"],
  ]);
  const updates = Array.from({ length: 52 }, (_, index) => ({
    type: "authored",
    activity: {
      ...note,
      id: String(index),
      supporting_document_id: detailIds.get(index) ?? null,
    },
  }));
  const doc = (id: string, title: string, trashed = false): Document => ({
    id,
    title,
    trashed,
    body: "",
    created_at: note.reported_at,
    updated_at: note.updated_at,
  });
  const pending = deferred<Document>();
  const reads: string[] = [];
  let revised = false;
  bridge.invoke.mockImplementation(
    async (command: string, args?: { id?: string; offset?: number }) => {
      if (command === "activity_feed") {
        const offset = args?.offset ?? 0;
        return updates.slice(offset, offset + 50);
      }
      if (command === "activity_update_count") return updates.length;
      if (command === "show_document" && args?.id) {
        const { id } = args;
        reads.push(id);
        if (id === "pending" && !revised) return pending.promise;
        if (id === "current" && revised) return doc(id, "Renamed", true);
        return doc(id, id);
      }
      throw new Error(`Unexpected ${command}`);
    },
  );
  const signal = fakeChangeSignal();
  render(<Activity {...props} reference="T-KQ20" signal={signal} />);
  await screen.findByRole("button", { name: "Attached: current" });
  expect(reads).toEqual(["current", "pending"]);

  fireEvent.click(
    await screen.findByRole("button", { name: "49 earlier updates" }),
  );
  await screen.findByRole("button", { name: "Attached: earlier" });
  expect(reads).toEqual(["current", "pending", "earlier"]);

  revised = true;
  await act(async () => signal.change());
  await screen.findByRole("button", { name: "Attached: Renamed" });
  expect(screen.getByText("In Trash")).toBeTruthy();
  expect(reads).toEqual([
    "current",
    "pending",
    "earlier",
    "current",
    "pending",
    "earlier",
  ]);
  await act(async () => pending.resolve(doc("pending", "Stale title")));
  expect(
    screen.getByRole("button", { name: "Attached: pending" }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Attached: Stale title" }),
  ).toBeNull();
});

test("reopening a cached ticket retries its failed detail Document read", async () => {
  const document: Document = {
    id: "details",
    title: "Recovered details",
    trashed: false,
    body: "",
    created_at: note.reported_at,
    updated_at: note.updated_at,
  };
  const showDocument = vi
    .fn()
    .mockRejectedValueOnce(new Error("Read failed"))
    .mockResolvedValue(document);
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "activity_feed")
      return [
        {
          type: "authored",
          activity: { ...note, supporting_document_id: document.id },
        },
      ];
    if (command === "show_document") return showDocument();
    throw new Error(`Unexpected ${command}`);
  });
  const reference = "T-KQ20";
  const view = render(<Activity {...props} reference={reference} />);
  await screen.findByRole("button", { name: "Open details" });
  expect(showDocument).toHaveBeenCalledTimes(1);

  view.rerender(
    <Activity {...props} reference={reference} active={false} hidden />,
  );
  view.rerender(<Activity {...props} reference={reference} />);
  expect(
    await screen.findByRole("button", { name: "Attached: Recovered details" }),
  ).toBeTruthy();
  expect(showDocument).toHaveBeenCalledTimes(2);
});

test("an update that occupies seven lines offers Show more", async () => {
  const brief = "An update that fills seven rendered lines.";
  const height = vi
    .spyOn(HTMLElement.prototype, "scrollHeight", "get")
    .mockImplementation(function (this: HTMLElement) {
      return this.textContent === brief ? 140 : 0;
    });
  const computedStyle = window.getComputedStyle;
  const style = vi
    .spyOn(window, "getComputedStyle")
    .mockImplementation((element, pseudo) => {
      const result = computedStyle(element, pseudo);
      if (element.textContent === brief) result.lineHeight = "20px";
      return result;
    });
  try {
    bridge.invoke.mockImplementation(async (command: string) => {
      if (command === "activity_feed")
        return [{ type: "authored", activity: { ...note, brief } }];
      throw new Error(`Unexpected ${command}`);
    });
    render(<Activity {...props} reference="T-KQ20" />);
    const more = await screen.findByRole("button", {
      name: "Show more",
      expanded: false,
    });
    fireEvent.click(more);
    expect(
      screen.getByRole("button", { name: "Show less", expanded: true }),
    ).toBeTruthy();
  } finally {
    height.mockRestore();
    style.mockRestore();
  }
});

test("a change that came from a source reads as the source, not as an agent", async () => {
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "list_sources") return [githubSource];
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
  fireEvent.click(screen.getByRole("radio", { name: "All" }));
  fireEvent.click(await screen.findByRole("button", { name: /^1 change:/ }));
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
  fireEvent.click(screen.getByRole("radio", { name: "All" }));
  fireEvent.click(await screen.findByRole("button", { name: /^1 change:/ }));
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
  render(<Activity {...props} reference="T-KQ50" latestNoteId="n" />);
  const body = await screen.findByText("Body");
  expect(screen.getByRole("heading", { name: /^Activity/ })).toBeTruthy();
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
  fireEvent.click(screen.getByRole("radio", { name: "All" }));
  fireEvent.click(await screen.findByRole("button", { name: /^2 changes:/ }));
  expect(screen.getByText("Added evidence “PR #482”")).toBeTruthy();
  expect(screen.getByText("Added evidence “fix branch”")).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: "Updates" }));
  expect(screen.queryByText(/Added evidence/)).toBeNull();
  expect(screen.getByText("Body")).toBeTruthy();
});

test("says no updates, not no activity, when the Updates filter hides only history (DB-21)", async () => {
  bridge.invoke.mockImplementation(
    async (command: string, args?: { updatesOnly?: boolean }) =>
      command === "activity_feed" && !args?.updatesOnly
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
  fireEvent.click(screen.getByRole("radio", { name: "All" }));
  fireEvent.click(await screen.findByRole("button", { name: /^1 change:/ }));
  await screen.findByText("Status Todo → In progress");
  fireEvent.click(screen.getByRole("radio", { name: "Updates" }));
  expect(await screen.findByText("No updates yet.")).toBeTruthy();
  expect(screen.queryByText(/No updates or recorded changes/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show all activity" }));
  expect(
    await screen.findByRole("button", { name: /^1 change:/ }),
  ).toBeTruthy();
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

test("the summary of a group of changes names every kind of change", () => {
  const change = (kind: string, to_value: string): Entry => ({
    kind,
    from_value: "",
    to_value,
    timestamp: "2026-10-31T11:00:00Z",
    editing_agent: null,
  });
  expect(changeSummary([change("trash", "trashed")])).toBe(
    "1 change: moved to Trash",
  );
  expect(changeSummary([change("trash", "active")])).toBe(
    "1 change: restored from Trash",
  );
  expect(changeSummary([change("tag", "a"), change("tag", "b")])).toBe(
    "2 changes: 2 tags",
  );
  expect(
    changeSummary([
      change("sync_parent_removed", "child"),
      change("source", "x"),
    ]),
  ).toBe("2 changes: 1 link, source");
});
