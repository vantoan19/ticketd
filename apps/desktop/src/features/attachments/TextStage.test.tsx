// @vitest-environment jsdom
import { useRef, type KeyboardEvent } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
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

function serve(text = LOG) {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "attachment_text") return new TextEncoder().encode(text);
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
  expect(
    await screen.findByText(
      "Showing the last 5 MB of 240 MB. Open it in its app for the rest.",
    ),
  ).toBeTruthy();
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
