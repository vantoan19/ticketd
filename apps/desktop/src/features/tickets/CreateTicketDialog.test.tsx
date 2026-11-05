// @vitest-environment jsdom
import { useRef, useState } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import type { Project } from "@/lib/api/client";
import type { Plan } from "@/lib/api/plans";
import { CreateTicketDialog } from "./CreateTicketDialog";

// The description editor loads lazily. Load it once up front so no test waits on
// the import, which is slow when many test files start together.
beforeAll(async () => {
  await import("@/features/markdown/MarkdownEditor");
});

// What the tag search answers; empty unless a test sets it.
const answers = vi.hoisted(() => ({ tags: [] as string[] }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string) =>
    Promise.resolve(command === "search_tags" ? answers.tags : []),
}));
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
      // CodeMirror binds Mod-Enter (insert blank line) and handles the event.
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey))
          event.preventDefault();
      }}
    />
  ),
}));
window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
afterEach(() => {
  cleanup();
  answers.tags = [];
});

function Harness({
  create,
  navigation = { project: "all", plan: "" },
  projects = [],
  plans = [],
}: {
  create: (
    title: string,
    body: string,
    status: string,
    project: string | null,
    plan: string | null,
    tags: string[],
    keepOpen: boolean,
  ) => Promise<string>;
  navigation?: { project: string; plan: string };
  projects?: Project[];
  plans?: Plan[];
}) {
  const [open, setOpen] = useState(true);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={triggerRef} onClick={() => setOpen(true)}>
        New ticket
      </button>
      <CreateTicketDialog
        open={open}
        onOpenChange={setOpen}
        triggerRef={triggerRef}
        navigation={navigation}
        projects={projects}
        plans={plans}
        create={create}
      />
    </>
  );
}

test("editor modes and toolbar actions never create a ticket; explicit submission retains a failed description draft", async () => {
  const create = vi.fn().mockRejectedValue(new Error("Disk full"));
  render(<Harness create={create} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
    target: { value: "Draft ticket" },
  });
  expect(
    await screen.findByRole("textbox", { name: "Description rich text" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Edit Markdown source" }));
  const source = screen.getByRole("textbox", { name: "Description source" });
  fireEvent.change(source, { target: { value: "# Draft\n\n- [ ] Keep this" } });
  // Source mode keeps CodeMirror's own Mod-Enter binding; it does not create.
  fireEvent.keyDown(source, { key: "Enter", ctrlKey: true });
  fireEvent.keyDown(source, { key: "Enter", metaKey: true });
  expect(create).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Use rich editor" }));
  fireEvent.focus(
    screen.getByRole("textbox", { name: "Description rich text" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Bold" }));
  expect(create).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Create ticket" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain("Disk full"),
  );
  expect(create).toHaveBeenCalledWith(
    "Draft ticket",
    "# Draft\n\n- [ ] Keep this",
    "Todo",
    null,
    null,
    [],
    false,
  );
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  fireEvent.click(screen.getByRole("button", { name: "New ticket" }));
  fireEvent.click(screen.getByRole("button", { name: "Edit Markdown source" }));
  expect(
    screen.getByRole("textbox", { name: "Description source" }),
  ).toHaveProperty("value", "# Draft\n\n- [ ] Keep this");
  expect(screen.getByText(/Draft restored/)).toBeTruthy();
});

test("Create ticket stays disabled with its reason until there is a title", () => {
  const create = vi.fn();
  render(<Harness create={create} />);
  const button = screen.getByRole("button", { name: "Create ticket" });
  expect(button).toHaveProperty("disabled", true);
  expect(screen.getByText("Add a title to create")).toBeTruthy();
  expect(button.getAttribute("aria-describedby")).toBeTruthy();
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
    target: { value: "Ready" },
  });
  expect(button).toHaveProperty("disabled", false);
  expect(screen.queryByText("Add a title to create")).toBeNull();
});

test("opening from a project scope preselects that project", () => {
  render(
    <Harness
      create={vi.fn()}
      navigation={{ project: "p", plan: "" }}
      projects={[{ id: "p", name: "Desktop app", path: "/w", paths: ["/w"] }]}
    />,
  );
  expect(
    screen.getByRole("combobox", { name: "Project: Desktop app" }),
  ).toBeTruthy();
});

test("Ctrl+Enter in the title creates the ticket", async () => {
  const create = vi.fn().mockResolvedValue("T-1");
  render(<Harness create={create} />);
  const title = screen.getByRole("textbox", { name: "Title" });
  fireEvent.change(title, { target: { value: "Quick" } });
  fireEvent.keyDown(title, { key: "Enter", ctrlKey: true });
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
});

async function focusedEditor() {
  const editor = await screen.findByRole("textbox", {
    name: "Description rich text",
  });
  // jsdom does not implement the contenteditable property Slate checks.
  Object.defineProperty(editor, "isContentEditable", { value: true });
  editor.focus();
  return editor;
}

test("Ctrl or Cmd+Enter in the focused Description editor creates the ticket; other keys do not", async () => {
  const create = vi.fn().mockResolvedValue("T-1");
  render(<Harness create={create} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
    target: { value: "From editor" },
  });
  const editor = await focusedEditor();
  fireEvent.keyDown(editor, { key: "Enter" });
  fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true, isComposing: true });
  fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true, shiftKey: true });
  fireEvent.keyDown(editor, { key: "Enter", metaKey: true, altKey: true });
  expect(create).not.toHaveBeenCalled();
  fireEvent.keyDown(editor, { key: "Enter", metaKey: true });
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
});

test("Ctrl+Enter in the Description editor creates the ticket", async () => {
  const create = vi.fn().mockResolvedValue("T-1");
  render(<Harness create={create} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
    target: { value: "From editor" },
  });
  fireEvent.keyDown(await focusedEditor(), { key: "Enter", ctrlKey: true });
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
});

test("Ctrl+Enter chooses the highlighted slash menu block instead of creating", async () => {
  const create = vi.fn().mockResolvedValue("T-1");
  render(<Harness create={create} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
    target: { value: "Slash" },
  });
  const editor = await focusedEditor();
  fireEvent.keyDown(editor, { key: "/" });
  const combo = screen.getByRole("combobox", { name: "Description rich text" });
  fireEvent.keyDown(combo, { key: "Enter", ctrlKey: true });
  expect(screen.queryByRole("listbox", { name: "Insert block" })).toBeNull();
  expect(create).not.toHaveBeenCalled();
});

test("Ctrl+Enter in the Link URL field does not create", async () => {
  const create = vi.fn().mockResolvedValue("T-1");
  render(<Harness create={create} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
    target: { value: "Link" },
  });
  await focusedEditor();
  fireEvent.click(screen.getByRole("button", { name: "Link" }));
  const url = await screen.findByLabelText("Link URL");
  fireEvent.keyDown(url, { key: "Enter", ctrlKey: true });
  fireEvent.keyDown(url, { key: "Enter", metaKey: true });
  expect(create).not.toHaveBeenCalled();
});

test("Create more keeps the dialog open, clears text, keeps properties, refocuses Title, and announces the reference", async () => {
  const create = vi
    .fn()
    .mockResolvedValueOnce("T-1")
    .mockResolvedValueOnce("T-2");
  render(
    <Harness
      create={create}
      navigation={{ project: "all", plan: "e1" }}
      plans={[{ id: "e1", name: "Sprint 1", archived: false, purpose: "" }]}
    />,
  );
  fireEvent.click(screen.getByRole("switch", { name: "Create more" }));
  const title = screen.getByRole("textbox", { name: "Title" });
  fireEvent.change(title, { target: { value: "First" } });
  // Focus is on the button that submitted, as it is for a real click.
  screen.getByRole("button", { name: "Create ticket" }).focus();
  fireEvent.click(screen.getByRole("button", { name: "Create ticket" }));
  await waitFor(() => expect(screen.getByText("Created T-1")).toBeTruthy());
  expect(screen.getByRole("dialog", { name: "New ticket" })).toBeTruthy();
  expect(title).toHaveProperty("value", "");
  expect(document.activeElement).toBe(title);
  expect(screen.getByRole("combobox", { name: "Plan: Sprint 1" })).toBeTruthy();
  fireEvent.change(title, { target: { value: "Second" } });
  fireEvent.click(screen.getByRole("button", { name: "Create ticket" }));
  await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
  expect(create.mock.calls.map((call) => [call[0], call[4], call[6]])).toEqual([
    ["First", "e1", true],
    ["Second", "e1", true],
  ]);
});

test("tags are chips that can be added and removed", () => {
  render(<Harness create={vi.fn()} />);
  const input = screen.getByRole("textbox", { name: "Add tag" });
  fireEvent.change(input, { target: { value: "Bug" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.getByText("bug")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove bug" }));
  expect(screen.queryByText("bug")).toBeNull();
});

test("suggested tags are options in the field's dropdown, not chips beside it", async () => {
  answers.tags = ["alpha", "beta"];
  render(<Harness create={vi.fn()} />);
  const input = screen.getByRole("textbox", { name: "Add tag" });
  expect(screen.queryByRole("listbox")).toBeNull();
  fireEvent.focus(input);
  const list = await screen.findByRole("listbox", {
    name: "Add tag suggestions",
  });
  fireEvent.click(within(list).getByRole("option", { name: "alpha" }));
  expect(screen.getByRole("button", { name: "Remove alpha" })).toBeTruthy();
  expect(screen.queryByRole("option", { name: "alpha" })).toBeNull();
  expect(screen.queryByRole("button", { name: "alpha" })).toBeNull();
});
