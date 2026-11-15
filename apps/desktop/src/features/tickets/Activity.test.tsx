// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Activity } from "./Activity";
import { DocumentNavigation } from "@/features/documents/navigation";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);
// Source entry exercises the real controlled editor; jsdom lacks the native
// selection and layout APIs used by the external CodeMirror widget.
vi.mock("@uiw/react-codemirror", () => ({
  default: ({
    value,
    onChange,
    readOnly,
    "aria-label": label,
  }: {
    value: string;
    onChange: (value: string) => void;
    readOnly: boolean;
    "aria-label": string;
  }) => (
    <textarea
      aria-label={label}
      readOnly={readOnly}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));
afterEach(() => {
  cleanup();
  bridge.invoke.mockReset();
  localStorage.clear();
  vi.restoreAllMocks();
});

test("preserves a note draft on a failed save and prevents repeated submissions", async () => {
  let rejectSave: (reason: Error) => void = () => {};
  bridge.invoke.mockImplementation((command: string) => {
    if (command === "ticket_history" || command === "activity_feed")
      return Promise.resolve([]);
    return new Promise((_resolve, reject) => {
      rejectSave = reject;
    });
  });
  render(
    <Activity
      reference="T-KQ1"
      status="Todo"
      revision={0}
      projects={[]}
      active
      trashed={false}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Write an update…" }));
  fireEvent.click(
    await screen.findByRole(
      "button",
      { name: "Edit Markdown source" },
      { timeout: 5000 },
    ),
  );
  const composer = screen.getByRole("textbox", { name: "New update source" });
  fireEvent.change(composer, { target: { value: "A **draft**" } });
  fireEvent.click(screen.getByRole("button", { name: "Post update" }));
  expect(
    screen.getByRole("button", { name: "Saving…" }).hasAttribute("disabled"),
  ).toBe(true);
  expect(composer).toHaveProperty("readOnly", true);
  fireEvent.submit(
    screen.getByRole("button", { name: "Saving…" }).closest("form")!,
  );
  await waitFor(() =>
    expect(bridge.invoke).toHaveBeenCalledWith(
      "add_activity_with_details",
      expect.anything(),
    ),
  );
  rejectSave(new Error("Database busy"));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain("Database busy"),
  );
  expect(composer).toHaveProperty("value", "A **draft**");
  expect(
    JSON.parse(localStorage.getItem("ticketd:activity-draft:T-KQ1") ?? "{}"),
  ).toMatchObject({ brief: "A **draft**" });
  expect(composer).toHaveProperty("readOnly", false);
  expect(
    bridge.invoke.mock.calls.filter(
      ([command]) => command === "add_activity_with_details",
    ),
  ).toHaveLength(1);
});

test("opens the selected note even when it is outside the loaded page", async () => {
  bridge.invoke.mockImplementation((command: string) => {
    if (command === "get_activity")
      return Promise.resolve({
        id: "older",
        ticket_id: "ticket-1",
        brief: "Edited finding",
        reported_at: "2026-01-01",
        updated_at: "2026-01-02",
        editing_agent: null,
      });
    if (command === "ticket_history" || command === "activity_feed")
      return Promise.resolve([]);
    throw new Error(`Unexpected command: ${command}`);
  });
  render(
    <Activity
      reference="T-KQ1"
      status="Todo"
      revision={0}
      projects={[]}
      active
      trashed={false}
      target={{ id: "older", key: 1 }}
    />,
  );
  const note = await screen.findByLabelText("Selected update");
  expect(note.textContent).toContain("Edited finding");
  expect(note.closest("ol")).not.toBeNull();
  expect(
    screen.getByRole("button", { name: /Actions for update from/ }),
  ).toBeTruthy();
  // Revealing a note also moves focus to it, so the keyboard lands there.
  expect(document.activeElement).toBe(note);
});

test("reveals the existing chronological note without scrolling the workspace", async () => {
  const selected = {
    id: "selected",
    ticket_id: "ticket-1",
    brief: "A single update",
    reported_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    editing_agent: null,
  };
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "get_activity") return selected;
    if (command === "activity_feed")
      return [{ type: "authored", activity: selected }];
    if (command === "ticket_history") return [];
    throw new Error(`Unexpected command: ${command}`);
  });
  const workspace = document.createElement("div");
  const scroller = document.createElement("div");
  workspace.scrollTop = 17;
  scroller.className = "detail-scroll";
  workspace.append(scroller);
  document.body.append(workspace);
  Object.defineProperty(scroller, "clientHeight", { value: 300 });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (this === scroller) return new DOMRect(0, 100, 500, 300);
      if (this.getAttribute("aria-label") === "Selected update")
        return new DOMRect(0, 500, 500, 100);
      return new DOMRect();
    },
  );
  render(
    <Activity
      reference="T-KQ1"
      status="In progress"
      revision={0}
      projects={[]}
      active
      trashed={false}
      latestNoteId="selected"
      target={{ id: "selected", key: 1 }}
    />,
    { container: scroller },
  );
  const note = await screen.findByLabelText("Selected update");
  await waitFor(() =>
    expect(screen.getAllByText("A single update")).toHaveLength(1),
  );
  expect(note.closest("ol")).not.toBeNull();
  expect(document.activeElement).toBe(note);
  expect(scroller.scrollTop).toBe(300);
  expect(workspace.scrollTop).toBe(17);
  workspace.remove();
});

test("does not duplicate an unloaded target when its page is later loaded", async () => {
  const selected = {
    id: "older",
    ticket_id: "ticket-1",
    brief: "Earlier update",
    reported_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    editing_agent: null,
  };
  const firstPage = Array.from({ length: 50 }, (_, index) => ({
    ...selected,
    id: `recent-${index}`,
    brief: `Recent update ${index}`,
    reported_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
  }));
  bridge.invoke.mockImplementation(
    async (command: string, args?: { offset: number }) => {
      if (command === "get_activity") return selected;
      if (command === "activity_feed")
        return (args?.offset ? [selected] : firstPage).map((activity) => ({
          type: "authored",
          activity,
        }));
      if (command === "ticket_history") return [];
      throw new Error(`Unexpected command: ${command}`);
    },
  );
  render(
    <Activity
      reference="T-KQ1"
      status="Todo"
      revision={0}
      projects={[]}
      active
      trashed={false}
      target={{ id: "older", key: 1 }}
    />,
  );
  const note = await screen.findByLabelText("Selected update");
  expect(note.closest("ol")).not.toBeNull();
  fireEvent.click(
    await screen.findByRole("button", { name: "Show more activity" }),
  );
  await waitFor(() =>
    expect(bridge.invoke).toHaveBeenCalledWith("activity_feed", {
      reference: "T-KQ1",
      limit: 50,
      offset: 50,
    }),
  );
  await waitFor(() =>
    expect(screen.getAllByText("Earlier update")).toHaveLength(1),
  );
});

test("an unloaded targeted note can be edited and deleted without a stale copy", async () => {
  let saved: {
    id: string;
    ticket_id: string;
    brief: string;
    reported_at: string;
    updated_at: string;
    editing_agent: string | null;
  } | null = {
    id: "older",
    ticket_id: "ticket-1",
    brief: "Earlier update",
    reported_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    editing_agent: null,
  };
  bridge.invoke.mockImplementation(
    async (command: string, args?: { patch: { brief: string } }) => {
      if (command === "get_activity") return saved;
      if (command === "activity_feed" || command === "ticket_history")
        return [];
      if (command === "edit_activity" && saved) {
        saved = { ...saved, brief: args!.patch.brief };
        return saved;
      }
      if (command === "delete_activity") {
        saved = null;
        return;
      }
      throw new Error(`Unexpected command: ${command}`);
    },
  );
  const targetProps = {
    reference: "T-KQ1",
    status: "Todo",
    revision: 0,
    projects: [],
    active: true,
    trashed: false,
    target: { id: "older", key: 1 },
  };
  const view = render(<Activity {...targetProps} />);
  await screen.findByText("Earlier update");
  fireEvent.pointerDown(
    screen.getByRole("button", { name: /Actions for update from/ }),
    { button: 0, ctrlKey: false },
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: "Edit update" }));
  expect(screen.queryByText(/The saved update changed/)).toBeNull();
  fireEvent.click(
    await screen.findByRole("button", { name: "Edit Markdown source" }),
  );
  fireEvent.change(
    screen.getByRole("textbox", { name: "Edit update source" }),
    {
      target: { value: "Edited earlier update" },
    },
  );
  saved = { ...saved!, brief: "Changed externally" };
  view.rerender(<Activity {...targetProps} revision={1} />);
  await screen.findByText(/The saved update changed/);
  expect(
    screen.getByRole("textbox", { name: "Edit update source" }),
  ).toHaveProperty("value", "Edited earlier update");
  fireEvent.click(screen.getByRole("button", { name: "Save update" }));
  await screen.findByText("Edited earlier update");
  expect(screen.queryByText("Earlier update")).toBeNull();
  fireEvent.pointerDown(
    screen.getByRole("button", { name: /Actions for update from/ }),
    { button: 0, ctrlKey: false },
  );
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Delete update" }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Delete update" }));
  await waitFor(() =>
    expect(screen.queryByText("Edited earlier update")).toBeNull(),
  );
});

test("finishing a note edit does not discard a newer note navigation", async () => {
  const first = {
    id: "first",
    ticket_id: "ticket-1",
    brief: "First target",
    reported_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    editing_agent: null,
  };
  const second = { ...first, id: "second", brief: "Second target" };
  let finishSave: (note: typeof first) => void = () => {};
  let finishSecond: (note: typeof first) => void = () => {};
  const save = new Promise<typeof first>((resolve) => (finishSave = resolve));
  const secondRead = new Promise<typeof first>(
    (resolve) => (finishSecond = resolve),
  );
  bridge.invoke.mockImplementation(
    async (command: string, args?: { id: string }) => {
      if (command === "get_activity")
        return args?.id === "second" ? secondRead : first;
      if (command === "activity_feed" || command === "ticket_history")
        return [];
      if (command === "edit_activity") return save;
      throw new Error(`Unexpected command: ${command}`);
    },
  );
  const targetProps = {
    reference: "T-KQ1",
    status: "Todo",
    revision: 0,
    projects: [],
    active: true,
    trashed: false,
  };
  const view = render(
    <Activity {...targetProps} target={{ id: "first", key: 1 }} />,
  );
  await screen.findByText("First target");
  fireEvent.pointerDown(
    screen.getByRole("button", { name: /Actions for update from/ }),
    { button: 0, ctrlKey: false },
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: "Edit update" }));
  fireEvent.click(screen.getByRole("button", { name: "Save update" }));
  view.rerender(
    <Activity {...targetProps} target={{ id: "second", key: 2 }} />,
  );
  await waitFor(() =>
    expect(bridge.invoke).toHaveBeenCalledWith("get_activity", {
      reference: "T-KQ1",
      id: "second",
    }),
  );
  await act(async () => finishSave({ ...first, brief: "Saved first" }));
  await waitFor(() => expect(screen.queryByText("Saving…")).toBeNull());
  await act(async () => finishSecond(second));
  expect(await screen.findByText("Second target")).toBeTruthy();
});

const props = {
  reference: "T-KQ1",
  status: "Todo",
  revision: 0,
  projects: [],
  active: true,
  trashed: false,
};
const original = {
  id: "note-1",
  ticket_id: "ticket-1",
  brief: "Original **note**",
  reported_at: "2026-10-31T10:00:00Z",
  updated_at: "2026-10-31T10:00:00Z",
  editing_agent: "cli-agent",
};

test("rejects blank notes and adds canonical Markdown only on explicit submission", async () => {
  const scoped = { ...props, reference: "T-KQ10" };
  let saved: (typeof original)[] = [];
  bridge.invoke.mockImplementation(
    async (command: string, args?: { brief: string }) => {
      if (command === "activity_feed")
        return saved.map((activity) => ({ type: "authored", activity }));
      if (command === "ticket_history") return [];
      if (command === "add_activity_with_details") {
        const note = { ...original, brief: args!.brief };
        saved = [note];
        return note;
      }
      throw new Error(`Unexpected ${command}`);
    },
  );
  render(<Activity {...scoped} />);
  expect(screen.queryByRole("textbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Write an update…" }));
  const add = screen.getByRole("button", { name: "Post update" });
  expect(add).toHaveProperty("disabled", true);
  fireEvent.submit(add.closest("form")!);
  fireEvent.click(
    await screen.findByRole("button", { name: "Edit Markdown source" }),
  );
  const source = screen.getByRole("textbox", { name: "New update source" });
  fireEvent.change(source, { target: { value: " \n\t" } });
  fireEvent.submit(add.closest("form")!);
  expect(
    bridge.invoke.mock.calls.filter(
      ([command]) => command === "add_activity_with_details",
    ),
  ).toHaveLength(0);
  fireEvent.change(source, { target: { value: "## Finding\n\n- [x] Done" } });
  fireEvent.click(screen.getByRole("button", { name: "Use rich editor" }));
  expect(
    screen.getByRole("textbox", { name: "New update rich text" }).textContent,
  ).toContain("Finding");
  // The formatting toolbar appears while the editor has focus.
  fireEvent.focus(
    screen.getByRole("textbox", { name: "New update rich text" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Bold" }));
  expect(
    bridge.invoke.mock.calls.filter(
      ([command]) => command === "add_activity_with_details",
    ),
  ).toHaveLength(0);
  fireEvent.click(add);
  await waitFor(() =>
    expect(screen.getByRole("heading", { name: "Finding" })).toBeTruthy(),
  );
  expect(saved[0]?.brief).toBe("## Finding\n\n- [x] Done");
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.getByRole("button", { name: "Write an update…" })).toBeTruthy();
});

test("preserves new and edited drafts across hidden navigation, external refresh and failed edits, then cancels back to the new draft", async () => {
  const scoped = { ...props, reference: "T-KQ11" };
  let saved = { ...original };
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "activity_feed")
      return [{ type: "authored", activity: saved }];
    if (command === "ticket_history") return [];
    if (command === "edit_activity") throw new Error("Disk full");
    throw new Error(`Unexpected ${command}`);
  });
  const view = render(<Activity {...scoped} />);
  await screen.findByText("cli-agent");
  fireEvent.click(screen.getByRole("button", { name: "Write an update…" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Edit Markdown source" }),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "New update source" }), {
    target: { value: "Unsubmitted new draft" },
  });
  fireEvent.pointerDown(
    screen.getByRole("button", { name: /Actions for update from/ }),
    { button: 0, ctrlKey: false },
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: "Edit update" }));
  expect(
    screen.getByRole("textbox", { name: "Edit update rich text" }).textContent,
  ).toContain("Original note");
  fireEvent.click(
    await screen.findByRole("button", { name: "Edit Markdown source" }),
  );
  fireEvent.change(
    screen.getByRole("textbox", { name: "Edit update source" }),
    {
      target: { value: "My edited **draft**" },
    },
  );
  view.rerender(<Activity {...scoped} active={false} />);
  saved = { ...saved, brief: "An external update" };
  view.rerender(<Activity {...scoped} revision={1} />);
  await screen.findByText(/The saved update changed while you were editing/);
  expect(
    screen.getByRole("textbox", { name: "Edit update source" }),
  ).toHaveProperty("value", "My edited **draft**");
  fireEvent.click(screen.getByRole("button", { name: "Save update" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain("Disk full"),
  );
  expect(
    screen.getByRole("textbox", { name: "Edit update source" }),
  ).toHaveProperty("value", "My edited **draft**");
  fireEvent.click(screen.getByRole("button", { name: "Cancel edit" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Edit Markdown source" }),
  );
  expect(
    screen.getByRole("textbox", { name: "New update source" }),
  ).toHaveProperty("value", "Unsubmitted new draft");
  view.rerender(<Activity {...scoped} revision={1} trashed />);
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByRole("button", { name: "Post update" })).toBeNull();
});

test("explicitly saves an edited note and returns to the untouched new draft", async () => {
  const scoped = { ...props, reference: "T-KQ12" };
  let saved = { ...original };
  bridge.invoke.mockImplementation(
    async (command: string, args?: { patch: { brief: string } }) => {
      if (command === "activity_feed")
        return [{ type: "authored", activity: saved }];
      if (command === "ticket_history") return [];
      if (command === "edit_activity") {
        saved = { ...saved, brief: args!.patch.brief };
        return saved;
      }
      throw new Error(`Unexpected ${command}`);
    },
  );
  render(<Activity {...scoped} />);
  await screen.findByText("cli-agent");
  fireEvent.pointerDown(
    screen.getByRole("button", { name: /Actions for update from/ }),
    { button: 0, ctrlKey: false },
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: "Edit update" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Edit Markdown source" }),
  );
  fireEvent.change(
    screen.getByRole("textbox", { name: "Edit update source" }),
    {
      target: { value: "## Edited finding" },
    },
  );
  fireEvent.click(screen.getByRole("button", { name: "Save update" }));
  await screen.findByRole("heading", { name: "Edited finding" });
  expect(saved.brief).toBe("## Edited finding");
  expect(screen.getByRole("button", { name: "Write an update…" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Cancel edit" })).toBeNull();
});

test("recovers an unpublished brief after the desktop restarts", async () => {
  localStorage.setItem(
    "ticketd:activity-draft:T-KQ987",
    "A recovered **brief**",
  );
  bridge.invoke.mockResolvedValue([]);
  render(
    <Activity
      reference="T-KQ987"
      status="Todo"
      revision={0}
      projects={[]}
      active
      trashed={false}
    />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Edit Markdown source" }),
  );
  expect(
    screen.getByRole("textbox", { name: "New update source" }),
  ).toHaveProperty("value", "A recovered **brief**");
  expect(
    bridge.invoke.mock.calls.some(
      ([command]) => command === "add_activity_with_details",
    ),
  ).toBe(false);
  localStorage.removeItem("ticketd:activity-draft:T-KQ987");
});

test("reports when a brief cannot be saved locally", async () => {
  bridge.invoke.mockResolvedValue([]);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Storage unavailable");
  });
  render(<Activity {...props} reference="T-KQ988" />);
  fireEvent.click(screen.getByRole("button", { name: "Write an update…" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Edit Markdown source" }),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "New update source" }), {
    target: { value: "Still in the editor" },
  });
  expect(screen.getByRole("alert").textContent).toContain(
    "Could not save the unpublished update",
  );
  expect(
    screen.getByRole("textbox", { name: "New update source" }),
  ).toHaveProperty("value", "Still in the editor");
});

test("restores unpublished details after remount", async () => {
  bridge.invoke.mockResolvedValue([]);
  const props = {
    reference: "T-KQ990",
    status: "Todo",
    revision: 0,
    projects: [],
    active: true,
    trashed: false,
  };
  const view = render(<Activity {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Write an update…" }));
  fireEvent.click(screen.getByRole("button", { name: "Add details" }));
  expect(await screen.findByText("Details")).toBeTruthy();
  const sourceButtons = await screen.findAllByRole("button", {
    name: "Edit Markdown source",
  });
  fireEvent.click(sourceButtons[1]!);
  fireEvent.change(screen.getByRole("textbox", { name: "Details source" }), {
    target: { value: "Evidence **draft**" },
  });
  view.unmount();
  render(<Activity {...props} />);
  expect(await screen.findByText("Details")).toBeTruthy();
  const restoredButtons = await screen.findAllByRole("button", {
    name: "Edit Markdown source",
  });
  fireEvent.click(restoredButtons[1]!);
  expect(
    screen.getByRole("textbox", { name: "Details source" }),
  ).toHaveProperty("value", "Evidence **draft**");
});

test("retries a failed details post with the same request identity and draft", async () => {
  let attempts = 0;
  bridge.invoke.mockImplementation((command: string) => {
    if (command === "activity_feed") return Promise.resolve([]);
    if (command === "add_activity_with_details") {
      attempts++;
      return Promise.reject(new Error("Connection lost"));
    }
    return Promise.resolve([]);
  });
  localStorage.setItem("ticketd:activity-draft:T-KQ991", "Brief");
  localStorage.setItem("ticketd:activity-details:T-KQ991", "Evidence");
  render(
    <Activity
      reference="T-KQ991"
      status="Todo"
      revision={0}
      projects={[]}
      active
      trashed={false}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Post update" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Post update" }));
  await waitFor(() => expect(attempts).toBe(2));
  const calls = bridge.invoke.mock.calls.filter(
    ([command]) => command === "add_activity_with_details",
  );
  expect(calls[0]?.[1]).toMatchObject({ brief: "Brief", details: "Evidence" });
  expect(calls[1]?.[1]).toEqual(calls[0]?.[1]);
  expect(localStorage.getItem("ticketd:activity-details:T-KQ991")).toBe(
    "Evidence",
  );
});

test("retries a brief-only post with the same request identity", async () => {
  bridge.invoke.mockImplementation((command: string) => {
    if (command === "add_activity_with_details")
      return Promise.reject(new Error("Connection lost"));
    return Promise.resolve([]);
  });
  localStorage.setItem("ticketd:activity-draft:T-KQ993", "Brief");
  render(
    <Activity
      reference="T-KQ993"
      status="Todo"
      revision={0}
      projects={[]}
      active
      trashed={false}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Post update" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Post update" }));
  await waitFor(() =>
    expect(
      bridge.invoke.mock.calls.filter(
        ([command]) => command === "add_activity_with_details",
      ),
    ).toHaveLength(2),
  );
  const calls = bridge.invoke.mock.calls.filter(
    ([command]) => command === "add_activity_with_details",
  );
  expect(calls[0]?.[1]).toMatchObject({
    brief: "Brief",
    details: null,
    existingDocumentId: null,
  });
  expect(calls[1]?.[1]).toEqual(calls[0]?.[1]);
});

test("restores a selected supporting Document after navigation", async () => {
  bridge.invoke.mockImplementation((command: string) => {
    if (command === "recent_documents")
      return Promise.resolve([{ id: "doc-1", heading: "Investigation" }]);
    if (command === "show_document")
      return Promise.resolve({
        id: "doc-1",
        title: "Investigation",
        body: "",
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
        trashed: false,
      });
    return Promise.resolve([]);
  });
  const props = {
    reference: "T-KQ992",
    status: "Todo",
    revision: 0,
    projects: [],
    active: true,
    trashed: false,
  };
  const view = render(<Activity {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Write an update…" }));
  fireEvent.click(screen.getByRole("button", { name: "Attach Document" }));
  fireEvent.click(await screen.findByRole("button", { name: "Investigation" }));
  view.unmount();
  render(<Activity {...props} />);
  expect(await screen.findByText("Attached: Investigation")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Remove attached Document" }),
  ).toBeTruthy();
});

test("a brief of only whitespace entities cannot be posted", async () => {
  render(
    <Activity
      reference="T-KQ993"
      status="Todo"
      revision={0}
      projects={[]}
      active
      trashed={false}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Write an update…" }));
  expect(screen.getByRole("button", { name: "Post update" })).toHaveProperty(
    "disabled",
    true,
  );
});

test("opens the exact supporting Document from its update", async () => {
  bridge.invoke.mockImplementation((command: string) => {
    if (command === "activity_feed")
      return Promise.resolve([
        {
          type: "authored",
          activity: {
            id: "activity-1",
            ticket_id: "ticket-1",
            brief: "Progress",
            reported_at: "2026-01-01",
            updated_at: "2026-01-01",
            editing_agent: null,
            supporting_document_id: "doc-exact",
          },
        },
      ]);
    if (command === "open_document")
      return Promise.resolve({
        id: "doc-exact",
        title: null,
        origin_brief: "Progress",
        body: "Evidence",
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
        trashed: true,
      });
    return Promise.resolve([]);
  });
  const open = vi.fn();
  render(
    <DocumentNavigation.Provider value={open}>
      <Activity
        reference="T-KQ993"
        status="Todo"
        revision={0}
        projects={[]}
        active
        trashed={false}
      />
    </DocumentNavigation.Provider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Open details" }));
  expect(open).toHaveBeenCalledWith("doc-exact");
});

test("offers refresh when the requested update was removed", async () => {
  const refresh = vi.fn().mockResolvedValue(undefined);
  bridge.invoke.mockImplementation((command: string) => {
    if (command === "get_activity") return Promise.resolve(null);
    if (command === "activity_feed") return Promise.resolve([]);
    throw new Error(`Unexpected command: ${command}`);
  });
  render(
    <Activity
      reference="T-KQ1"
      status="Todo"
      revision={0}
      projects={[]}
      active
      trashed={false}
      target={{ id: "removed", key: 1 }}
      onChanged={refresh}
    />,
  );
  await screen.findByText(/update is no longer available/i);
  fireEvent.click(screen.getByRole("button", { name: "Refresh updates" }));
  expect(refresh).toHaveBeenCalled();
});

test("restores the whole draft, brief, details and attached Document, from one object", async () => {
  bridge.invoke.mockImplementation((command: string) => {
    if (command === "show_document")
      return Promise.resolve({
        id: "doc-1",
        title: "Investigation",
        body: "",
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
        trashed: false,
      });
    return Promise.resolve([]);
  });
  localStorage.setItem(
    "ticketd:activity-draft:T-KQ994",
    JSON.stringify({ brief: "Brief", details: "More", support: "doc-1" }),
  );
  render(
    <Activity
      reference="T-KQ994"
      status="Todo"
      revision={0}
      projects={[]}
      active
      trashed={false}
    />,
  );
  expect(await screen.findByText("Attached: Investigation")).toBeTruthy();
  expect(await screen.findByText("Brief")).toBeTruthy();
  expect(screen.getByText("Draft kept on this device")).toBeTruthy();
});

test("opening the composer puts the caret in the update editor", async () => {
  bridge.invoke.mockImplementation(() => Promise.resolve([]));
  render(
    <Activity
      reference="T-KQ77"
      status="Todo"
      revision={0}
      projects={[]}
      active
      trashed={false}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Write an update…" }));
  await screen.findByRole(
    "button",
    { name: "Edit Markdown source" },
    { timeout: 5000 },
  );
  await waitFor(() =>
    expect(
      document.activeElement?.closest(".activity-composer"),
    ).not.toBeNull(),
  );
});
