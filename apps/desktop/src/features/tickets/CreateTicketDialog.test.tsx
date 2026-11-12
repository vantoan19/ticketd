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
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { Project } from "@/lib/api/client";
import type { Plan } from "@/lib/api/plans";
import { DraftRecoveryProvider } from "@/lib/draft-recovery";
import type { DraftRetention } from "@/lib/api/attachments";
import { CreateTicketDialog } from "./CreateTicketDialog";

// The description editor loads lazily. Load it once up front so no test waits on
// the import, which is slow when many test files start together.
beforeAll(async () => {
  await import("@/features/markdown/MarkdownEditor");
});

// What the tag search answers; empty unless a test sets it.
const answers = vi.hoisted(() => ({
  tags: [] as string[],
  invoke:
    vi.fn<
      (command: string, args?: Record<string, unknown>) => Promise<unknown>
    >(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: answers.invoke,
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
  answers.invoke.mockReset();
  localStorage.removeItem("ticketd.preferences");
});
beforeEach(() => {
  answers.invoke.mockImplementation(async (command) => {
    if (command === "search_tags") return answers.tags;
    if (command === "draft_retentions") return [];
    if (command === "draft_cutover_pending") return false;
    return null;
  });
});

function recoveryBridge({ failFirstRelease = true } = {}) {
  const records = new Map<string, DraftRetention>();
  let releaseAttempts = 0;
  let failNextRelease = failFirstRelease;
  answers.invoke.mockImplementation(async (command, args) => {
    if (command === "search_tags") return answers.tags;
    if (command === "draft_retentions") return [...records.values()];
    if (command === "draft_cutover_pending") return false;
    if (command === "retain_draft") {
      const draft = args?.draft as DraftRetention;
      if (draft.owner === "new-ticket" && draft.payload === null) {
        releaseAttempts += 1;
        if (failNextRelease) {
          failNextRelease = false;
          throw new Error("Recovery storage is temporarily unavailable");
        }
      }
      const saved = { ...draft, revision: draft.revision + 1 };
      records.set(saved.owner, saved);
      return saved;
    }
    return null;
  });
  return { records, getReleaseAttempts: () => releaseAttempts };
}

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
    requestId?: string,
    followCreated?: boolean,
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
    expect.any(String),
    true,
  );
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  fireEvent.click(screen.getByRole("button", { name: "New ticket" }));
  fireEvent.click(screen.getByRole("button", { name: "Edit Markdown source" }));
  expect(
    screen.getByRole("textbox", { name: "Description source" }),
  ).toHaveProperty("value", "# Draft\n\n- [ ] Keep this");
  expect(screen.getByText(/Draft restored/)).toBeTruthy();
});

test("the empty description says what to write and that Markdown works", async () => {
  render(<Harness create={vi.fn()} />);
  const editor = await screen.findByRole("textbox", {
    name: "Description rich text",
  });
  expect(editor.style.getPropertyValue("--editor-placeholder")).toBe(
    '"Steps, acceptance criteria, or a checklist"',
  );
  expect(screen.getByText("Markdown works · type / for blocks")).toBeTruthy();
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

test("the primary shortcut hint names the platform modifier", () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  render(<Harness create={vi.fn()} />);
  const button = screen.getByRole("button", { name: /^Create ticket/ });
  expect(button.textContent).toBe("Create ticketCtrl↵");
  vi.restoreAllMocks();
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
  const create = vi.fn().mockResolvedValue("T-KQ1");
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
  const create = vi.fn().mockResolvedValue("T-KQ1");
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
  const create = vi.fn().mockResolvedValue("T-KQ1");
  render(<Harness create={create} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
    target: { value: "From editor" },
  });
  fireEvent.keyDown(await focusedEditor(), { key: "Enter", ctrlKey: true });
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
});

test("Ctrl+Enter chooses the highlighted slash menu block instead of creating", async () => {
  const create = vi.fn().mockResolvedValue("T-KQ1");
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
  const create = vi.fn().mockResolvedValue("T-KQ1");
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
    .mockResolvedValueOnce("T-KQ1")
    .mockResolvedValueOnce("T-KQ2");
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
  await waitFor(() => expect(screen.getByText("Created T-KQ1")).toBeTruthy());
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
  const requestIds = create.mock.calls.map((call) => call[7]);
  expect(requestIds[0]).toEqual(expect.any(String));
  expect(requestIds[1]).toEqual(expect.any(String));
  expect(requestIds[0]).not.toBe(requestIds[1]);
});

test("retrying recovery cleanup after creation does not create a duplicate ticket", async () => {
  const recovery = recoveryBridge();
  const create = vi.fn().mockResolvedValue("T-KQ3");
  render(
    <DraftRecoveryProvider>
      <Harness create={create} />
    </DraftRecoveryProvider>,
  );
  fireEvent.change(await screen.findByRole("textbox", { name: "Title" }), {
    target: { value: "Created before cleanup failed" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create ticket" }));
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  expect(await screen.findByText(/T-KQ3 was created/)).toBeTruthy();
  expect(create).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByRole("button", { name: "Finish cleanup" }));
  await waitFor(() => expect(recovery.getReleaseAttempts()).toBe(2));
  expect(create).toHaveBeenCalledTimes(1);
});

test("a lost-response submission reuses its request ID and follow choice after remount", async () => {
  const recovery = recoveryBridge({ failFirstRelease: false });
  const accepted = new Map<
    string,
    { fingerprint: string; reference: string }
  >();
  let loseFirstResponse = true;
  const create = vi.fn(
    async (
      title: string,
      body: string,
      status: string,
      project: string | null,
      plan: string | null,
      tags: string[],
      _keepOpen: boolean,
      requestId?: string,
      followCreated?: boolean,
    ) => {
      const fingerprint = JSON.stringify([
        title,
        body,
        status,
        project,
        plan,
        tags,
        followCreated,
      ]);
      if (requestId) {
        const previous = accepted.get(requestId);
        if (previous) {
          if (previous.fingerprint !== fingerprint)
            throw new Error(
              "Submission ID conflicts with its original payload",
            );
          return previous.reference;
        }
      }
      const reference = `T-KQ${accepted.size + 1}`;
      if (requestId) accepted.set(requestId, { fingerprint, reference });
      if (requestId && loseFirstResponse) {
        loseFirstResponse = false;
        throw new Error("Ticket was committed but its response was lost");
      }
      return reference;
    },
  );
  const first = render(
    <DraftRecoveryProvider>
      <Harness create={create} />
    </DraftRecoveryProvider>,
  );
  fireEvent.change(await screen.findByRole("textbox", { name: "Title" }), {
    target: { value: "Created before restart" },
  });
  fireEvent.click(screen.getByRole("switch", { name: "Create more" }));
  await waitFor(() => expect(recovery.records.has("new-ticket")).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: "Create ticket" }));
  expect(
    await screen.findByText(/Could not confirm whether the ticket was created/),
  ).toBeTruthy();
  expect(recovery.records.get("new-ticket")?.payload).toMatchObject({
    title: "Created before restart",
    requestId: expect.any(String),
    followCreated: true,
  });
  first.unmount();

  localStorage.setItem(
    "ticketd.preferences",
    JSON.stringify({
      theme: "system",
      openTickets: "split",
      ticketLayout: "list",
      sidebarCollapsed: false,
      ticketRows: "detailed",
      followCreated: false,
      notifyReminders: false,
    }),
  );
  render(
    <DraftRecoveryProvider>
      <Harness create={create} />
    </DraftRecoveryProvider>,
  );
  expect(await screen.findByRole("textbox", { name: "Title" })).toHaveProperty(
    "value",
    "Created before restart",
  );
  expect(
    screen
      .getByRole("switch", { name: "Create more" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Retry safely" }));
  await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(recovery.records.get("new-ticket")?.payload).toBeNull(),
  );
  expect(create.mock.calls[0]?.[7]).toEqual(create.mock.calls[1]?.[7]);
  expect(create.mock.calls[0]?.[7]).toEqual(expect.any(String));
  expect(create.mock.calls.map((call) => call[8])).toEqual([true, true]);
  expect(create.mock.calls.map((call) => call[6])).toEqual([true, true]);
  expect(accepted.size).toBe(1);
});

test.each([false, true])(
  "editing an uncertain submission waits for durable saving (save fails: %s)",
  async (saveFails) => {
    const recovery = recoveryBridge({ failFirstRelease: false });
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error("The response was lost"))
      .mockResolvedValueOnce("T-KQ2");
    render(
      <DraftRecoveryProvider>
        <Harness create={create} />
      </DraftRecoveryProvider>,
    );
    const title = await screen.findByRole("textbox", { name: "Title" });
    fireEvent.change(title, { target: { value: "Preserve my draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Create ticket" }));
    expect(await screen.findByText(/Could not confirm whether/)).toBeTruthy();
    expect(title).toHaveProperty("disabled", true);
    const originalId = create.mock.calls[0]?.[7];

    fireEvent.click(screen.getByRole("button", { name: "Edit draft" }));
    expect(screen.getByText(/earlier ticket may already exist/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep retrying" }));
    expect(title).toHaveProperty("disabled", true);
    expect(recovery.records.get("new-ticket")?.payload).toMatchObject({
      requestId: originalId,
    });

    fireEvent.click(screen.getByRole("button", { name: "Edit draft" }));
    const invokeNormally = answers.invoke.getMockImplementation()!;
    let saveStarted = false;
    let finishSave: () => void = () => {};
    const saving = new Promise<void>((resolve, reject) => {
      finishSave = saveFails
        ? () => reject(new Error("Draft save failed"))
        : resolve;
    });
    answers.invoke.mockImplementation(async (command, args) => {
      if (command === "retain_draft") {
        saveStarted = true;
        await saving;
      }
      return invokeNormally(command, args);
    });
    fireEvent.click(screen.getByRole("button", { name: "Edit as new ticket" }));
    await waitFor(() => expect(saveStarted).toBe(true));
    expect(title).toHaveProperty("disabled", true);
    expect(create).toHaveBeenCalledTimes(1);
    finishSave();
    if (saveFails) {
      expect(
        await screen.findByText(
          /original submission is still available to retry/,
        ),
      ).toBeTruthy();
      expect(title).toHaveProperty("disabled", true);
      expect(recovery.records.get("new-ticket")?.payload).toMatchObject({
        requestId: originalId,
      });
      expect(
        screen.queryByRole("button", { name: "Create ticket" }),
      ).toBeNull();
      expect(create).toHaveBeenCalledTimes(1);
      return;
    }
    await waitFor(() => expect(title).toHaveProperty("disabled", false));
    expect(title).toHaveProperty("value", "Preserve my draft");
    expect(recovery.records.get("new-ticket")?.payload).not.toHaveProperty(
      "requestId",
    );
    expect(recovery.records.get("new-ticket")?.payload).not.toHaveProperty(
      "followCreated",
    );
    expect(create).toHaveBeenCalledTimes(1);
    fireEvent.change(title, { target: { value: "Corrected draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Create ticket" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[1]?.[7]).not.toBe(originalId);
  },
);

test("closing an empty recovered submission preserves its request identity", async () => {
  const recovery = recoveryBridge({ failFirstRelease: false });
  const requestId = crypto.randomUUID();
  recovery.records.set("new-ticket", {
    owner: "new-ticket",
    kind: "draft",
    revision: 1,
    markdown: [],
    payload: {
      title: "",
      body: "",
      status: "Todo",
      project: "",
      plan: "",
      tags: [],
      restored: true,
      requestId,
      followCreated: true,
    },
  });
  const first = render(
    <DraftRecoveryProvider>
      <Harness create={vi.fn()} />
    </DraftRecoveryProvider>,
  );
  await screen.findByRole("textbox", { name: "Title" });
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await waitFor(() =>
    expect(recovery.records.get("new-ticket")?.payload).toMatchObject({
      requestId,
    }),
  );
  first.unmount();
  render(
    <DraftRecoveryProvider>
      <Harness create={vi.fn()} />
    </DraftRecoveryProvider>,
  );
  expect(
    await screen.findByRole("button", { name: "Retry safely" }),
  ).toBeTruthy();
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
