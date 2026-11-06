// @vitest-environment jsdom

import { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { test, vi, expect, afterEach } from "vitest";
import { TicketEditor } from "@/features/tickets/TicketEditor";
import type { Ticket } from "@/lib/api/client";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);

afterEach(() => {
  localStorage.clear();
  cleanup();
  document
    .querySelectorAll("[data-test-workspace]")
    .forEach((node) => node.remove());
  vi.useRealTimers();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

const initial: Ticket = {
  id: "1",
  reference: "T-1",
  title: "First",
  body: "Old",
  status: "Todo",
  trashed: false,
  tags: [],
  project_id: null,
  plan_id: null,
  availability: "Ready",
  prerequisites: [],
  parent: null,
  children: [],
};
function Harness() {
  const [ticket, setTicket] = useState(initial);
  return <TicketEditor ticket={ticket} onSaved={setTicket} />;
}
async function autosave() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(600);
  });
}
async function editDescription() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Edit description" }));
    await import("@/features/markdown/MarkdownEditor");
  });
}

test("an untouched ticket reports no save state until something is saved", async () => {
  vi.useFakeTimers();
  bridge.invoke.mockResolvedValue({ ...initial, title: "Renamed" });
  render(<Harness />);
  expect(screen.getByRole("status").textContent).toBe("");
  fireEvent.change(screen.getByLabelText("Title"), {
    target: { value: "Renamed" },
  });
  expect(screen.getByRole("status").textContent).toBe("Pending save");
  await autosave();
  expect(screen.getByRole("status").textContent).toBe("Title saved");
});

test("a title-only save should not overwrite an externally updated body", async () => {
  vi.useFakeTimers();
  let stored = { ...initial, body: "External agent body" };
  bridge.invoke.mockImplementation(
    async (_command: string, { patch }: { patch: Partial<Ticket> }) => {
      stored = { ...stored, ...patch };
      return stored;
    },
  );
  render(<Harness />);
  fireEvent.change(screen.getByLabelText("Title"), {
    target: { value: "Renamed" },
  });
  await autosave();
  await autosave();
  expect(stored.body).toBe("External agent body");
  expect(bridge.invoke).toHaveBeenCalledExactlyOnceWith("change_ticket", {
    reference: "T-1",
    patch: { title: "Renamed", expected_title: "First" },
  });
});

test("reading, selection, focus and editor mode changes preserve source without saving", async () => {
  vi.useFakeTimers();
  const source =
    "###   Hello\n\n[Read more](https://example.com)\n\n- [ ] Keep exact source\n";
  const onSaved = vi.fn();
  const { rerender } = render(
    <TicketEditor ticket={{ ...initial, body: source }} onSaved={onSaved} />,
  );
  const heading = screen.getByRole("heading", { name: "Hello" });
  const link = screen.getByRole("link", { name: "Read more" });
  link.addEventListener("click", (event) => event.preventDefault());
  fireEvent.click(link);
  expect(screen.queryByRole("button", { name: "Done editing" })).toBeNull();
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(heading);
  selection?.addRange(range);
  fireEvent.click(heading);
  expect(screen.queryByRole("button", { name: "Done editing" })).toBeNull();
  selection?.removeAllRanges();
  await editDescription();
  const rich = screen.getByRole("textbox", { name: "Description rich text" });
  fireEvent.focus(rich);
  fireEvent.blur(rich);
  rerender(
    <TicketEditor ticket={{ ...initial, body: source }} onSaved={onSaved} />,
  );
  expect(screen.getByRole("textbox", { name: "Description rich text" })).toBe(
    rich,
  );
  fireEvent.click(screen.getByRole("button", { name: "Edit Markdown source" }));
  expect(
    screen.getByRole("textbox", { name: "Description source" }).textContent,
  ).toContain("###   Hello");
  fireEvent.click(screen.getByRole("button", { name: "Use rich editor" }));
  const currentRich = screen.getByRole("textbox", {
    name: "Description rich text",
  });
  fireEvent.click(screen.getByRole("button", { name: "Done editing" }));
  await editDescription();
  expect(screen.getByRole("textbox", { name: "Description rich text" })).toBe(
    currentRich,
  );
  await autosave();
  expect(bridge.invoke).not.toHaveBeenCalled();
});

test("keeps a failed Unicode rich draft visible and retries only the description patch", async () => {
  vi.useFakeTimers();
  const ticket = { ...initial, body: "# Xin chào\n\n- [ ] Second line 🌿" };
  bridge.invoke.mockRejectedValueOnce(new Error("Disk full"));
  const onSaved = vi.fn();
  const { rerender } = render(
    <TicketEditor ticket={ticket} onSaved={onSaved} />,
  );
  await editDescription();
  fireEvent.click(screen.getByRole("checkbox", { name: "Checklist item" }));
  await autosave();
  fireEvent.click(screen.getByRole("button", { name: "Done editing" }));
  expect(screen.getByRole("heading", { name: "Xin chào" })).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toContain("Disk full");
  expect(screen.getByRole("checkbox")).toHaveProperty("checked", true);
  rerender(
    <TicketEditor
      ticket={{ ...ticket, title: "External title" }}
      onSaved={onSaved}
    />,
  );
  expect(screen.getByLabelText("Title")).toHaveProperty(
    "value",
    "External title",
  );
  expect(screen.getByRole("listitem").textContent).toContain("Second line 🌿");
  bridge.invoke.mockResolvedValueOnce({
    ...ticket,
    title: "External title",
    body: "# Xin chào\n\n- [x] Second line 🌿",
  });
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await autosave();
  expect(bridge.invoke).toHaveBeenLastCalledWith("change_ticket", {
    reference: "T-1",
    patch: {
      body: "# Xin chào\n\n- [x] Second line 🌿",
      expected_body: "# Xin chào\n\n- [ ] Second line 🌿",
    },
  });
  expect(screen.getByRole("status").textContent).toBe("Description saved");
});

test("external description changes pause a rich draft until reload or overwrite is chosen", async () => {
  vi.useFakeTimers();
  const ticket = { ...initial, body: "- [ ] My draft\n" };
  const onSaved = vi.fn();
  const { rerender } = render(
    <TicketEditor ticket={ticket} onSaved={onSaved} />,
  );
  await editDescription();
  fireEvent.click(screen.getByRole("checkbox", { name: "Checklist item" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const external = { ...ticket, body: "- [ ] External content\n" };
  rerender(<TicketEditor ticket={external} onSaved={onSaved} />);
  await autosave();
  expect(bridge.invoke).not.toHaveBeenCalled();
  expect(
    screen.getByRole("checkbox", { name: "Checklist item" }),
  ).toHaveProperty("checked", true);
  fireEvent.click(screen.getByRole("button", { name: "Use saved text" }));
  // A draft with text is only discarded after a confirmation.
  fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(
    screen.getByRole("textbox", { name: "Description rich text" }).textContent,
  ).toContain("External content");
  fireEvent.click(screen.getByRole("checkbox", { name: "Checklist item" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  rerender(
    <TicketEditor
      ticket={{ ...external, body: "Another external edit" }}
      onSaved={onSaved}
    />,
  );
  bridge.invoke.mockResolvedValueOnce({
    ...external,
    body: "- [x] External content",
  });
  fireEvent.click(screen.getByRole("button", { name: "Keep my draft" }));
  await autosave();
  expect(bridge.invoke).toHaveBeenCalledExactlyOnceWith("change_ticket", {
    reference: "T-1",
    patch: {
      body: "- [x] External content",
      expected_body: "Another external edit",
    },
  });
});

test("focuses the description on entry and reentry for rich and source documents", async () => {
  vi.useFakeTimers();
  for (const body of [
    "Editable description",
    "<aside>Source required</aside>",
  ]) {
    render(<TicketEditor ticket={{ ...initial, body }} onSaved={vi.fn()} />);
    await editDescription();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30);
    });
    const editable = body.startsWith("<")
      ? screen.getByRole("textbox", { name: "Description source" })
      : screen.getByRole("textbox", { name: "Description rich text" });
    expect(document.activeElement).toBe(editable);
    fireEvent.click(screen.getByRole("button", { name: "Done editing" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30);
    });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Edit description" }),
    );
    await editDescription();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30);
    });
    expect(document.activeElement).toBe(editable);
    cleanup();
  }
});

test("navigates references in Markdown text while leaving code and links alone", async () => {
  const select = vi.fn();
  bridge.invoke.mockResolvedValue({ ...initial, reference: "T-2" });
  render(
    <TicketEditor
      ticket={
        {
          ...initial,
          body: "See T-2 and `T-3` and [website](https://example.com/T-4)",
        } as never
      }
      onSaved={vi.fn()}
      select={select}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "T-2" }));
  expect(select).toHaveBeenCalledWith("T-2");
  expect(screen.queryByRole("button", { name: "T-3" })).toBeNull();
  expect(
    screen.getByRole("link", { name: "website" }).getAttribute("href"),
  ).toBe("https://example.com/T-4");
});

// A backlink as the core reports it: the source line, and where the reference sits in it.
function at(body: string, line: string, nth = 0, key = 1) {
  let from = -1;
  for (let i = 0; i <= nth; i++) from = body.indexOf(line, from + 1);
  const start = from + line.indexOf("T-1");
  return { passage: line, mentioned: "T-1", start, end: start + 3, key };
}
const marked = () => document.querySelector("[data-mention-target]");
function renderMention(body: string, line: string, nth = 0) {
  const workspace = document.createElement("div");
  const scroller = document.createElement("div");
  workspace.dataset.testWorkspace = "";
  workspace.scrollTop = 17;
  scroller.className = "detail-scroll";
  workspace.append(scroller);
  document.body.append(workspace);
  Object.defineProperty(scroller, "clientHeight", { value: 300 });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (this === scroller) return new DOMRect(0, 100, 500, 300);
      if (this.hasAttribute("data-mention-target"))
        return new DOMRect(0, 500, 500, 100);
      return new DOMRect();
    },
  );
  const ticket = { ...initial, id: "9", reference: "T-9", body };
  const view = render(
    <TicketEditor
      ticket={ticket}
      onSaved={vi.fn()}
      mention={at(body, line, nth)}
    />,
    { container: scroller },
  );
  return { ticket, view, scroller, workspace };
}

test("a description mention is scrolled to, highlighted and focused in place, then cleared", async () => {
  const body =
    "Intro paragraph.\n\n- Blocked on **T-1** until Friday.\n- Unrelated.";
  const { ticket, view, scroller, workspace } = renderMention(
    body,
    "- Blocked on **T-1** until Friday.",
  );
  const item = marked();
  expect(item?.tagName).toBe("LI");
  expect(item?.textContent).toBe("Blocked on T-1 until Friday.");
  expect(document.activeElement).toBe(item);
  expect(item?.getAttribute("tabindex")).toBe("-1");
  expect(scroller.scrollTop).toBe(300);
  expect(workspace.scrollTop).toBe(17);
  expect(
    document.getElementById(item?.getAttribute("aria-describedby") ?? "")
      ?.textContent,
  ).toBe("Mentions T-1");
  view.rerender(
    <TicketEditor ticket={ticket} onSaved={vi.fn()} mention={null} />,
  );
  expect(marked()).toBeNull();
  expect(
    screen
      .getByText("Blocked on", { exact: false })
      .closest("li")
      ?.hasAttribute("tabindex"),
  ).toBe(false);
});

test("a line with a link marks its own paragraph, not an earlier mention", () => {
  renderMention(
    "Intro: T-1 is the parent.\n\nBlocked on T-1 with [the spec](https://example.com/spec).",
    "Blocked on T-1 with [the spec](https://example.com/spec).",
  );
  expect(marked()?.textContent).toBe("Blocked on T-1 with the spec.");
});

test("a table row mention marks its cell", () => {
  renderMention("| Ref | State |\n|---|---|\n| T-1 | Done |", "| T-1 | Done |");
  expect(marked()?.tagName).toBe("TD");
  expect(marked()?.textContent).toBe("T-1");
});

test("a later paragraph that contains the passage does not win over the real item", () => {
  renderMention(
    "Note: the blocker T-1 is still open.\n\n- T-1 is still open.",
    "- T-1 is still open.",
  );
  expect(marked()?.tagName).toBe("LI");
});

test("identical lines are told apart by position", () => {
  renderMention(
    "Blocked on T-1.\n\nOther.\n\nBlocked on T-1.",
    "Blocked on T-1.",
    1,
  );
  const paragraphs = [...document.querySelectorAll(".description-document p")];
  expect(paragraphs.indexOf(marked() as Element)).toBe(2);
});

test("a code block above the mention keeps its tab stop and is never marked", () => {
  const body = "Run:\n\n```sh\n./check T-1\n```\n\nBlocked on T-1 here.";
  const { ticket, view } = renderMention(body, "Blocked on T-1 here.");
  const pre = document.querySelector("pre");
  expect(marked()?.tagName).toBe("P");
  expect(pre?.getAttribute("tabindex")).toBe("0");
  view.rerender(
    <TicketEditor ticket={ticket} onSaved={vi.fn()} mention={null} />,
  );
  expect(document.querySelector("pre")?.getAttribute("tabindex")).toBe("0");
});

test("leaving edit mode does not bring the highlight back or scroll again", async () => {
  const { scroller } = renderMention(
    "Intro.\n\nBlocked on T-1 today.",
    "Blocked on T-1 today.",
  );
  expect(marked()).not.toBeNull();
  expect(scroller.scrollTop).toBe(300);
  scroller.scrollTop = 12;
  fireEvent.click(screen.getByRole("button", { name: "Edit description" }));
  await act(async () => {
    await import("@/features/markdown/MarkdownEditor");
  });
  fireEvent.click(screen.getByRole("button", { name: "Done editing" }));
  expect(marked()).toBeNull();
  expect(scroller.scrollTop).toBe(12);
});

test("an external change to the description drops the highlight", () => {
  const { view, ticket } = renderMention(
    "Intro.\n\nBlocked on T-1 today.",
    "Blocked on T-1 today.",
  );
  expect(marked()).not.toBeNull();
  view.rerender(
    <TicketEditor
      ticket={{
        ...ticket,
        body: "Added first.\n\nIntro.\n\nBlocked on T-1 today.",
      }}
      onSaved={vi.fn()}
      mention={at(ticket.body, "Blocked on T-1 today.")}
    />,
  );
  expect(marked()).toBeNull();
});

test("spans count chars from a body without its byte order mark, past astral characters", () => {
  const body = "\uFEFF😀 Émoji first.\n\nSee T-1 here.\n\nAlso T-1 there.";
  const text = [...body.slice(1)];
  const start = text.indexOf("S") + "See ".length;
  render(
    <TicketEditor
      ticket={{ ...initial, id: "9", body }}
      onSaved={vi.fn()}
      mention={{
        passage: "See T-1 here.",
        mentioned: "T-1",
        start,
        end: start + 3,
        key: 1,
      }}
    />,
  );
  expect(marked()?.textContent).toBe("See T-1 here.");
});

test("a passage that is gone says so and lands on the description without guessing", async () => {
  const stale = at("Blocked on T-1 today.", "Blocked on T-1 today.");
  render(
    <TicketEditor
      ticket={{ ...initial, id: "9", body: "Intro: T-1 is the parent." }}
      onSaved={vi.fn()}
      mention={stale}
    />,
  );
  const note = await screen.findByText(/Couldn't find the mention of T-1/);
  expect(note.getAttribute("aria-live")).toBe("polite");
  expect(document.activeElement).toBe(
    screen.getByRole("group", { name: "Description" }),
  );
  expect(marked()).toBeNull();
});

test("an empty description has one add affordance and keeps focus when editing ends", async () => {
  render(
    <TicketEditor
      ticket={{ ...initial, id: "empty-description", body: "" }}
      onSaved={vi.fn()}
    />,
  );
  expect(
    screen.getByRole("button", { name: "Add a description…" }),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Edit description" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Add a description…" }));
  fireEvent.click(screen.getByRole("button", { name: "Done editing" }));
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Add a description…" }),
    ),
  );
});

test("a save the core refuses as stale keeps the draft and offers the choice", async () => {
  vi.useFakeTimers();
  const agent = { ...initial, title: "Agent title", body: "Agent wrote this" };
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "change_ticket")
      throw "ticket 'T-1' was changed elsewhere since it was loaded";
    return agent;
  });
  render(<Harness />);
  await editDescription();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30);
  });
  const editor = screen.getByRole("textbox", {
    name: "Description rich text",
  });
  await act(async () => {
    editor.focus();
    document.execCommand?.("insertText", false, " mine");
  });
  fireEvent.change(screen.getByLabelText("Title"), {
    target: { value: "My title" },
  });
  await autosave();
  expect(bridge.invoke).toHaveBeenCalledWith(
    "change_ticket",
    expect.objectContaining({
      patch: { title: "My title", expected_title: "First" },
    }),
  );
  expect(
    screen.getByText(/changed elsewhere.*while you were editing/),
  ).toBeTruthy();
  expect((screen.getByLabelText("Title") as HTMLTextAreaElement).value).toBe(
    "My title",
  );
  expect(screen.queryByRole("alert")).toBeNull();
  // The notice holds autosave: nothing more is written until the person chooses.
  bridge.invoke.mockClear();
  await autosave();
  expect(bridge.invoke).not.toHaveBeenCalled();
});

test("a clean editor adopts an external change without a notice", async () => {
  const onSaved = vi.fn();
  const { rerender } = render(
    <TicketEditor ticket={initial} onSaved={onSaved} />,
  );
  rerender(
    <TicketEditor
      ticket={{ ...initial, body: "Agent body" }}
      onSaved={onSaved}
    />,
  );
  expect(screen.getByText("Agent body")).toBeTruthy();
  expect(
    screen.queryByText(/changed elsewhere.*while you were editing/),
  ).toBeNull();
});

test("a conflict shows the saved text as the description and the draft as labelled", () => {
  const onSaved = vi.fn();
  localStorage.setItem(
    "ticketd:ticket-draft:1",
    JSON.stringify({
      title: "First",
      body: "My unsaved words",
      baseTitle: "First",
      baseBody: "Old",
    }),
  );
  render(
    <TicketEditor
      ticket={{ ...initial, body: "Agent saved text" }}
      onSaved={onSaved}
    />,
  );
  const notice = screen.getByText(/saved description changed/);
  const body = document.querySelector(".editor-body");
  expect(body?.contains(notice)).toBe(true);
  expect(screen.getByText("Agent saved text")).toBeTruthy();
  expect(screen.getByText("Your unsaved draft")).toBeTruthy();
  expect(screen.getByText("My unsaved words")).toBeTruthy();
  expect(bridge.invoke).not.toHaveBeenCalled();
});

test("an empty draft takes the saved text without a confirmation", () => {
  localStorage.setItem(
    "ticketd:ticket-draft:1",
    JSON.stringify({
      title: "First",
      body: "",
      baseTitle: "First",
      baseBody: "Old",
    }),
  );
  render(
    <TicketEditor
      ticket={{ ...initial, body: "Agent saved text" }}
      onSaved={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Use saved text" }));
  expect(screen.queryByRole("button", { name: "Discard draft" })).toBeNull();
  expect(screen.queryByText("Your unsaved draft")).toBeNull();
  expect(localStorage.getItem("ticketd:ticket-draft:1")).toBeNull();
});

test("unsaved text survives a reload and is checked against the stored text", async () => {
  vi.useFakeTimers();
  bridge.invoke.mockImplementation(() => new Promise(() => {}));
  const first = render(<TicketEditor ticket={initial} onSaved={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("Title"), {
    target: { value: "My title" },
  });
  expect(
    JSON.parse(localStorage.getItem("ticketd:ticket-draft:1") ?? ""),
  ).toEqual({
    title: "My title",
    body: "Old",
    baseTitle: "First",
    baseBody: "Old",
  });
  first.unmount();
  // Reload: the stored ticket is unchanged, so the draft simply returns.
  render(<TicketEditor ticket={initial} onSaved={vi.fn()} />);
  expect((screen.getByLabelText("Title") as HTMLTextAreaElement).value).toBe(
    "My title",
  );
  expect(
    screen.queryByText(/changed elsewhere.*while you were editing/),
  ).toBeNull();
  cleanup();
  // Reload after an agent changed the title: the conflict is raised.
  render(
    <TicketEditor
      ticket={{ ...initial, title: "Agent title" }}
      onSaved={vi.fn()}
    />,
  );
  expect((screen.getByLabelText("Title") as HTMLTextAreaElement).value).toBe(
    "My title",
  );
  expect(screen.getByText(/saved title changed/)).toBeTruthy();
  expect(screen.getByText("Agent title")).toBeTruthy();
});

test("clicking the description text does not start editing; the Edit button does", () => {
  render(
    <TicketEditor
      ticket={{ ...initial, body: "Some **text**" }}
      onSaved={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByText("Some"));
  expect(screen.getByRole("button", { name: "Edit description" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Done editing" })).toBeNull();
});
