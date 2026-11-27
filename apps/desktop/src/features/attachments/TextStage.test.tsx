// @vitest-environment jsdom
import { useRef, type KeyboardEvent } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { TextStage } from "./TextStage";
import { loadPreferences, setPreference } from "@/lib/preferences";
import type { Attachment } from "@/lib/api/attachments";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {},
  convertFileSrc: (value: string) => `http://localhost/${value}`,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
beforeEach(() => setPreference("attachmentWrap", true));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const file: Attachment = {
  id: "log-1",
  display_name: "e2e-run.log",
  original_filename: "e2e-run.log",
  size_bytes: 4096,
  kind: "local_snapshot",
  locator: "log-1/bytes/e2e-run.log",
};

// Long lines and repeated text: a test run's log.
const LONG = "GET /api/tickets?filter=" + "status%3Dopen%26".repeat(40);
const lines = Array.from({ length: 200 }, (_, index) =>
  index === 7
    ? LONG
    : index % 50 === 3
      ? `12:00:${index} ERROR checkout timeout`
      : `12:00:${index} INFO request done`,
);
const LOG = lines.join("\n") + "\n";
const WHOLE = {
  total_bytes: LOG.length,
  shown_bytes: LOG.length,
  partial: false,
};

function serve(text = LOG, firstLine = 1) {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "attachment_text") return new TextEncoder().encode(text);
    if (command === "attachment_text_first_line") return firstLine;
    throw new Error(`Unexpected ${command}`);
  });
}
function Stage({
  scope = WHOLE,
  onRetry = () => {},
}: {
  scope?: typeof WHOLE;
  onRetry?: () => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const keys = useRef<((event: KeyboardEvent) => void) | null>(null);
  return (
    <div
      ref={scroller}
      data-testid="stage"
      tabIndex={-1}
      onKeyDown={(event) => keys.current?.(event)}
    >
      <TextStage
        workspace="workspace"
        file={file}
        scope={scope}
        attempt={0}
        onRetry={onRetry}
        scrollerRef={scroller}
        keysRef={keys}
        reachable={false}
      />
    </div>
  );
}
function drawn() {
  return [...document.querySelectorAll<HTMLElement>("[data-line]")];
}
function press(key: string, init: Partial<KeyboardEventInit> = {}) {
  fireEvent.keyDown(document.activeElement ?? document.body, { key, ...init });
}

test("a log draws its numbered lines, never all of them, and says when it is only the end", async () => {
  serve();
  const view = render(<Stage />);
  await screen.findByRole("document", { name: "Text of e2e-run.log" });
  const rows = drawn();
  // The first screens only: 64 lines a block, two blocks around the view.
  expect(rows[0]!.dataset["n"]).toBe("1");
  expect(rows[0]!.textContent).toBe(lines[0]);
  expect(rows.length).toBeLessThan(lines.length);
  expect(rows.length % 64).toBe(0);
  // The line number is generated, never part of the text.
  expect(rows[1]!.textContent).toBe(lines[1]);
  expect(screen.queryByText(/Showing the last/)).toBeNull();
  view.unmount();

  serve();
  render(
    <Stage
      scope={{
        total_bytes: 240 * 1024 * 1024,
        shown_bytes: 5 * 1024 * 1024,
        partial: true,
      }}
    />,
  );
  const note = await screen.findByText(
    "Showing the last 5 MB of 240 MB. Open it in its app for the rest.",
  );
  // The same info glyph as the other notice lines.
  expect(note.querySelector("svg[aria-hidden='true']")).toBeTruthy();
});

test("the end of a long log keeps the file's own line numbers", async () => {
  serve(LOG, 3_410_207);
  render(
    <Stage
      scope={{
        total_bytes: 22 * 1024 * 1024,
        shown_bytes: 5 * 1024 * 1024,
        partial: true,
      }}
    />,
  );
  await screen.findByRole("document", { name: "Text of e2e-run.log" });
  const rows = drawn();
  expect(rows[0]!.dataset["n"]).toBe("3410207");
  expect(rows[1]!.dataset["n"]).toBe("3410208");
  expect(invoke).toHaveBeenCalledWith("attachment_text_first_line", {
    workspace: "workspace",
    id: "log-1",
  });
});

test("a whole log is numbered from 1 without asking for a start line", async () => {
  serve();
  render(<Stage />);
  await screen.findByRole("document", { name: "Text of e2e-run.log" });
  expect(drawn()[0]!.dataset["n"]).toBe("1");
  expect(invoke).not.toHaveBeenCalledWith(
    "attachment_text_first_line",
    expect.anything(),
  );
});

test("a log that can't be read says so and retries", async () => {
  vi.mocked(invoke).mockRejectedValueOnce(new Error("offline"));
  const retry = vi.fn();
  render(<Stage onRetry={retry} />);
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  expect(retry).toHaveBeenCalledOnce();
});

test("find counts every match, marks them, steps with Enter and closes with Esc keeping the match selected", async () => {
  serve();
  render(<Stage />);
  await screen.findByRole("document");
  const stage = screen.getByTestId("stage");
  // jsdom has no layout: a scroll position the test controls.
  let top = 0;
  Object.defineProperty(stage, "scrollTop", {
    get: () => top,
    set: (value: number) => {
      top = value;
    },
  });
  stage.focus();
  // / opens it with the field focused, so a later letter types there.
  press("/");
  const field = await screen.findByRole("textbox", {
    name: "Find in the text",
  });
  await waitFor(() => expect(document.activeElement).toBe(field));
  fireEvent.change(field, { target: { value: "error checkout" } });
  const status = screen.getByRole("status");
  await waitFor(() => expect(status.textContent).toBe("1 of 4"));
  // Only the lines near the view are drawn, so only their matches are marked.
  const marks = () => [...document.querySelectorAll("mark")];
  expect(marks()).toHaveLength(2);
  const current = () =>
    marks().findIndex((mark) => mark.hasAttribute("data-current"));
  expect(current()).toBe(0);
  fireEvent.keyDown(field, { key: "Enter" });
  await waitFor(() => expect(status.textContent).toBe("2 of 4"));
  expect(current()).toBe(1);
  // Shift+Enter goes back, past the first to the last: the view follows it.
  fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
  fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
  await waitFor(() => expect(status.textContent).toBe("4 of 4"));
  await waitFor(() => expect(top).toBeGreaterThan(0));
  fireEvent.scroll(stage);
  await waitFor(() => expect(current()).toBeGreaterThanOrEqual(0));
  expect(
    marks()[current()]!.closest<HTMLElement>("[data-line]")!.dataset["line"],
  ).toBe("153");

  fireEvent.change(field, { target: { value: "nothing like this" } });
  await waitFor(() => expect(status.textContent).toBe("No matches"));
  fireEvent.change(field, { target: { value: "status%3Dopen" } });
  await waitFor(() => expect(status.textContent).toBe("1 of 40"));
  // The view went back to the first match; the repeated phrase counts each time.
  await waitFor(() => expect(top).toBe(0));
  fireEvent.scroll(stage);
  await waitFor(() => expect(marks()).toHaveLength(40));

  fireEvent.keyDown(field, { key: "Escape" });
  expect(
    screen.queryByRole("textbox", { name: "Find in the text" }),
  ).toBeNull();
  expect(marks()).toHaveLength(0);
  // The stage has its keys back, and the match is what a copy would take.
  expect(document.activeElement).toBe(stage);
  expect(window.getSelection()?.toString()).toBe("status%3Dopen");
});

test("a capped match count reads in the same grouped numbers on both sides", async () => {
  serve("x\n".repeat(20_500));
  render(<Stage />);
  await screen.findByRole("document");
  const stage = screen.getByTestId("stage");
  stage.focus();
  press("/");
  const field = await screen.findByRole("textbox", {
    name: "Find in the text",
  });
  fireEvent.change(field, { target: { value: "x" } });
  const status = screen.getByRole("status");
  await waitFor(() => expect(status.textContent).toBe("1 of 20,000+"));
  fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
  await waitFor(() => expect(status.textContent).toBe("20,000 of 20,000+"));
});

test("keys type in the Find field instead of acting, and W wraps outside it", async () => {
  serve();
  render(<Stage />);
  await screen.findByRole("document");
  const stage = screen.getByTestId("stage");
  stage.focus();
  const wrap = screen.getByRole("button", { name: "Wrap lines" });
  expect(wrap.getAttribute("aria-pressed")).toBe("true");
  press("w");
  expect(wrap.getAttribute("aria-pressed")).toBe("false");
  // The choice is kept for the next file.
  expect(loadPreferences().attachmentWrap).toBe(false);
  expect(
    document.querySelector(".attachment-text")?.hasAttribute("data-wrap"),
  ).toBe(false);
  fireEvent.click(wrap);
  expect(wrap.getAttribute("aria-pressed")).toBe("true");

  fireEvent.click(screen.getByRole("button", { name: "Find" }));
  const field = await screen.findByRole("textbox", {
    name: "Find in the text",
  });
  fireEvent.keyDown(field, { key: "w" });
  fireEvent.keyDown(field, { key: "/" });
  expect(wrap.getAttribute("aria-pressed")).toBe("true");
  // ⌘F in the field selects it again rather than opening a second one.
  fireEvent.keyDown(field, { key: "f", metaKey: true, ctrlKey: false });
  expect(screen.getAllByRole("textbox")).toHaveLength(1);
});

test("copying a selection takes the text of its lines, without line numbers", async () => {
  serve();
  render(<Stage />);
  await screen.findByRole("document");
  const rows = drawn();
  const first = rows[3]!.querySelector(".attachment-text-content")!.firstChild!;
  const last = rows[5]!.querySelector(".attachment-text-content")!.firstChild!;
  const range = document.createRange();
  range.setStart(first, 9);
  range.setEnd(last, 8);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  const copied = new Map<string, string>();
  const event = new Event("copy", { bubbles: true, cancelable: true });
  Object.assign(event, {
    clipboardData: {
      setData: (type: string, value: string) => copied.set(type, value),
    },
  });
  document.querySelector(".attachment-text")!.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  expect(copied.get("text/plain")).toBe(
    `${lines[3]!.slice(9)}\n${lines[4]}\n${lines[5]!.slice(0, 8)}`,
  );
});

test("Wrap lines keeps the line at the top of the view instead of the same scroll position", async () => {
  const text = Array.from(
    { length: 100 },
    (_, index) => `L${index} ${"x".repeat(30)}`,
  ).join("\n");
  serve(text);
  render(<Stage />);
  await screen.findByRole("document");
  const stage = screen.getByTestId("stage");
  let top = 0;
  Object.defineProperty(stage, "scrollTop", {
    get: () => top,
    set: (value: number) => {
      top = value;
    },
  });
  // jsdom has no layout: wrapped, every line is two 20px rows, so line n sits at 40n.
  const original = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function () {
    const line = this.dataset["line"];
    if (line === undefined) return { top: 0, bottom: 0 } as DOMRect;
    const at = Number(line) * 40 - top;
    return { top: at, bottom: at + 40 } as DOMRect;
  };
  try {
    top = 1010; // line 25, 10px of it scrolled out
    stage.focus();
    press("w");
    await waitFor(() =>
      expect(screen.getByRole("document").hasAttribute("data-wrap")).toBe(
        false,
      ),
    );
    // Unwrapped, a line is one row: line 25 now starts at 500, with the same 10px above.
    expect(top).toBe(510);
  } finally {
    HTMLElement.prototype.getBoundingClientRect = original;
  }
});

test("a match past the right edge of an unwrapped line is scrolled into view sideways", async () => {
  serve(`${"x".repeat(5000)} needle\nshort\n`);
  render(<Stage />);
  await screen.findByRole("document");
  const stage = screen.getByTestId("stage");
  // jsdom has no layout: a 300px stage that scrolls sideways as far as the test lets it.
  Object.defineProperty(stage, "clientWidth", { value: 300 });
  let left = 0;
  Object.defineProperty(stage, "scrollLeft", {
    get: () => left,
    set: (value: number) => {
      left = value;
    },
  });
  stage.focus();
  press("w");
  await waitFor(() =>
    expect(screen.getByRole("document").hasAttribute("data-wrap")).toBe(false),
  );
  press("/");
  const field = await screen.findByRole("textbox", {
    name: "Find in the text",
  });
  fireEvent.change(field, { target: { value: "needle" } });
  await waitFor(() => expect(left).toBeGreaterThan(5000));
});

test("select all and copy take every line of the log, drawn or not, not the page around it", async () => {
  serve();
  render(<Stage />);
  await screen.findByRole("document");
  const stage = screen.getByTestId("stage");
  stage.focus();
  const key = new KeyboardEvent("keydown", {
    key: "a",
    metaKey: true,
    bubbles: true,
    cancelable: true,
  });
  stage.dispatchEvent(key);
  expect(key.defaultPrevented).toBe(true);
  const list = document.querySelector(".attachment-text")!;
  const selection = window.getSelection()!;
  expect(selection.anchorNode).toBe(list);
  expect(selection.focusNode).toBe(list);
  expect(drawn().length).toBeLessThan(lines.length);
  const copied = new Map<string, string>();
  const event = new Event("copy", { bubbles: true, cancelable: true });
  Object.assign(event, {
    clipboardData: {
      setData: (type: string, value: string) => copied.set(type, value),
    },
  });
  list.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  expect(copied.get("text/plain")).toBe(lines.join("\n"));
  // In the Find field, ⌘A still selects the field's own text.
  press("/");
  const field = await screen.findByRole("textbox", {
    name: "Find in the text",
  });
  const inField = new KeyboardEvent("keydown", {
    key: "a",
    metaKey: true,
    bubbles: true,
    cancelable: true,
  });
  field.dispatchEvent(inField);
  expect(inField.defaultPrevented).toBe(false);
});

test("a copy still starts where the drag began after that line scrolls out of the drawn rows", async () => {
  serve();
  render(<Stage />);
  await screen.findByRole("document");
  const list = document.querySelector(".attachment-text")!;
  const rows = drawn();
  const first = rows[3]!.querySelector(".attachment-text-content")!.firstChild!;
  const last = rows[5]!.querySelector(".attachment-text-content")!.firstChild!;
  const selection = window.getSelection()!;
  selection.setBaseAndExtent(first, 9, last, 8);
  document.dispatchEvent(new Event("selectionchange"));
  // The browser moves the edge whose rows were taken out of the page onto the list.
  selection.setBaseAndExtent(list, 0, last, 8);
  document.dispatchEvent(new Event("selectionchange"));
  const copied = new Map<string, string>();
  const event = new Event("copy", { bubbles: true, cancelable: true });
  Object.assign(event, {
    clipboardData: {
      setData: (type: string, value: string) => copied.set(type, value),
    },
  });
  list.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  expect(copied.get("text/plain")).toBe(
    `${lines[3]!.slice(9)}\n${lines[4]}\n${lines[5]!.slice(0, 8)}`,
  );
});
