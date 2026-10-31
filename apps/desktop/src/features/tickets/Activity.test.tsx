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
  fireEvent.click(screen.getByRole("button", { name: "Add a note" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Edit Markdown source" }),
  );
  const composer = screen.getByRole("textbox", { name: "New note source" });
  fireEvent.change(composer, { target: { value: "A **draft**" } });
  fireEvent.click(screen.getByRole("button", { name: "Add note" }));
  expect(
    screen.getByRole("button", { name: "Saving…" }).hasAttribute("disabled"),
  ).toBe(true);
  expect(composer).toHaveProperty("readOnly", true);
  fireEvent.submit(
    screen.getByRole("button", { name: "Saving…" }).closest("form")!,
  );
  rejectSave(new Error("Database busy"));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain("Database busy"),
  );
  expect(composer).toHaveProperty("value", "A **draft**");
  expect(composer).toHaveProperty("readOnly", false);
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
  const note = await screen.findByLabelText("Selected note");
  expect(note.textContent).toContain("Edited finding");
  // Revealing a note also moves focus to it, so the keyboard lands there.
  expect(document.activeElement).toBe(note);
});

const props = {
  reference: "T-1",
  status: "Todo",
  revision: 0,
  projects: [],
  active: true,
  trashed: false,
};
const original = {
  id: "note-1",
  content: "Original **note**",
  created_at: "2026-10-31T10:00:00Z",
  updated_at: "2026-10-31T10:00:00Z",
  editing_agent: "cli-agent",
};

test("rejects blank notes and adds canonical Markdown only on explicit submission", async () => {
  const scoped = { ...props, reference: "T-10" };
  let saved: (typeof original)[] = [];
  bridge.invoke.mockImplementation(
    async (command: string, args?: { content: string }) => {
      if (command === "list_notes") return saved;
      if (command === "ticket_history") return [];
      if (command === "add_note") {
        const note = { ...original, content: args!.content };
        saved = [note];
        return note;
      }
      throw new Error(`Unexpected ${command}`);
    },
  );
  render(<Activity {...scoped} />);
  expect(screen.queryByRole("textbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Add a note" }));
  const add = screen.getByRole("button", { name: "Add note" });
  expect(add).toHaveProperty("disabled", true);
  fireEvent.submit(add.closest("form")!);
  fireEvent.click(
    await screen.findByRole("button", { name: "Edit Markdown source" }),
  );
  const source = screen.getByRole("textbox", { name: "New note source" });
  fireEvent.change(source, { target: { value: " \n\t" } });
  fireEvent.submit(add.closest("form")!);
  expect(
    bridge.invoke.mock.calls.filter(([command]) => command === "add_note"),
  ).toHaveLength(0);
  fireEvent.change(source, { target: { value: "## Finding\n\n- [x] Done" } });
  fireEvent.click(screen.getByRole("button", { name: "Use rich editor" }));
  expect(
    screen.getByRole("textbox", { name: "New note rich text" }).textContent,
  ).toContain("Finding");
  fireEvent.click(screen.getByRole("button", { name: "Bold" }));
  expect(
    bridge.invoke.mock.calls.filter(([command]) => command === "add_note"),
  ).toHaveLength(0);
  fireEvent.click(add);
  await waitFor(() =>
    expect(screen.getByRole("heading", { name: "Finding" })).toBeTruthy(),
  );
  expect(saved[0]?.content).toBe("## Finding\n\n- [x] Done");
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.getByRole("button", { name: "Add a note" })).toBeTruthy();
});

test("preserves new and edited drafts across hidden navigation, external refresh and failed edits, then cancels back to the new draft", async () => {
  const scoped = { ...props, reference: "T-11" };
  let saved = { ...original };
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "list_notes") return [saved];
    if (command === "ticket_history") return [];
    if (command === "edit_note") throw new Error("Disk full");
    throw new Error(`Unexpected ${command}`);
  });
  const view = render(<Activity {...scoped} />);
  await screen.findByText("Agent: cli-agent");
  fireEvent.click(screen.getByRole("button", { name: "Add a note" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Edit Markdown source" }),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "New note source" }), {
    target: { value: "Unsubmitted new draft" },
  });
  fireEvent.pointerDown(
    screen.getByRole("button", { name: /Actions for note from/ }),
    { button: 0, ctrlKey: false },
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: "Edit note" }));
  expect(
    screen.getByRole("textbox", { name: "Edit note rich text" }).textContent,
  ).toContain("Original note");
  fireEvent.click(
    await screen.findByRole("button", { name: "Edit Markdown source" }),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Edit note source" }), {
    target: { value: "My edited **draft**" },
  });
  view.rerender(<Activity {...scoped} active={false} />);
  saved = { ...saved, content: "An external update" };
  view.rerender(<Activity {...scoped} revision={1} />);
  await screen.findByText(/The saved note changed while you were editing/);
  expect(
    screen.getByRole("textbox", { name: "Edit note source" }),
  ).toHaveProperty("value", "My edited **draft**");
  fireEvent.click(screen.getByRole("button", { name: "Save note" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain("Disk full"),
  );
  expect(
    screen.getByRole("textbox", { name: "Edit note source" }),
  ).toHaveProperty("value", "My edited **draft**");
  fireEvent.click(screen.getByRole("button", { name: "Cancel edit" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Edit Markdown source" }),
  );
  expect(
    screen.getByRole("textbox", { name: "New note source" }),
  ).toHaveProperty("value", "Unsubmitted new draft");
  view.rerender(<Activity {...scoped} revision={1} trashed />);
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByRole("button", { name: "Add note" })).toBeNull();
});

test("explicitly saves an edited note and returns to the untouched new draft", async () => {
  const scoped = { ...props, reference: "T-12" };
  let saved = { ...original };
  bridge.invoke.mockImplementation(
    async (command: string, args?: { patch: { content: string } }) => {
      if (command === "list_notes") return [saved];
      if (command === "ticket_history") return [];
      if (command === "edit_note") {
        saved = { ...saved, content: args!.patch.content };
        return saved;
      }
      throw new Error(`Unexpected ${command}`);
    },
  );
  render(<Activity {...scoped} />);
  await screen.findByText("Agent: cli-agent");
  fireEvent.pointerDown(
    screen.getByRole("button", { name: /Actions for note from/ }),
    { button: 0, ctrlKey: false },
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: "Edit note" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Edit Markdown source" }),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Edit note source" }), {
    target: { value: "## Edited finding" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save note" }));
  await screen.findByRole("heading", { name: "Edited finding" });
  expect(saved.content).toBe("## Edited finding");
  expect(screen.getByRole("button", { name: "Add a note" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Cancel edit" })).toBeNull();
});
