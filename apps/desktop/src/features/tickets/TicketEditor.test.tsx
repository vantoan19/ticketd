// @vitest-environment jsdom

import { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { test, vi, expect, afterEach } from "vitest";
import { TicketEditor } from "@/features/tickets/TicketEditor";
import type { Ticket } from "@/lib/api/client";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
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
  effort_id: null,
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
    patch: { title: "Renamed" },
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
  expect(screen.getByLabelText("Description source").textContent).toContain(
    "###   Hello",
  );
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
  const ticket = { ...initial, body: "# Xin chào\n\n- [ ] Second line 🌿\n" };
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
    body: "# Xin chào\n\n- [x] Second line 🌿\n",
  });
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await autosave();
  expect(bridge.invoke).toHaveBeenLastCalledWith("change_ticket", {
    reference: "T-1",
    patch: { body: "# Xin chào\n\n- [x] Second line 🌿\n" },
  });
  expect(screen.getByRole("status").textContent).toBe("Saved");
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
  fireEvent.click(screen.getByRole("button", { name: "Reload saved content" }));
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
    body: "- [x] External content\n",
  });
  fireEvent.click(screen.getByRole("button", { name: "Save my draft" }));
  await autosave();
  expect(bridge.invoke).toHaveBeenCalledExactlyOnceWith("change_ticket", {
    reference: "T-1",
    patch: { body: "- [x] External content\n" },
  });
});
