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
import { invoke } from "@tauri-apps/api/core";
import { AttachmentCard } from "./AttachmentCard";
import { FileGrid } from "./FileCard";
import { fitName } from "./file-name";
import type { Attachment } from "@/lib/api/attachments";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {},
  convertFileSrc: (value: string) =>
    `http://attachment-media.localhost/${value}`,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

function stored(id: string, name: string, size = 4096): Attachment {
  return {
    id,
    display_name: name,
    original_filename: name,
    size_bytes: size,
    kind: "local_snapshot",
    locator: `${id}/bytes/${name}`,
  };
}
function info(file: Attachment, media_type: string | null = "image/png") {
  return {
    attachment: file,
    status: "available",
    media_type,
    message: null,
    can_open: true,
    usage: { total: 0, legacy_drafts_pending: false, entries: [] },
  };
}

/** An IntersectionObserver the test drives: `arrive()` brings every card near. */
function viewport() {
  const callbacks: Array<(entries: IntersectionObserverEntry[]) => void> = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: (entries: IntersectionObserverEntry[]) => void) {
        callbacks.push(callback);
      }
      observe() {}
      disconnect() {}
    },
  );
  return () =>
    act(() => {
      for (const callback of callbacks)
        callback([{ isIntersecting: true } as IntersectionObserverEntry]);
    });
}

test("a card is a labeled tile with the app's type word and size, and one action", () => {
  const onOpen = vi.fn();
  render(
    <AttachmentCard
      file={stored("l", "e2e-run.log", 2.4 * 1048576)}
      onOpen={onOpen}
    />,
  );
  const card = screen.getByRole("button", { name: "e2e-run.log" });
  expect(card.textContent).toContain("LOG");
  expect(card.textContent).toContain("Log · 2.4 MB");
  // The storage is not mentioned when the file is simply here.
  expect(card.textContent).not.toContain("On this computer");
  fireEvent.click(card);
  expect(onOpen).toHaveBeenCalledTimes(1);
});

test("storage replaces the type word only when the file isn't simply here", () => {
  const html = stored("h", "load-test.html", 3.4 * 1048576);
  const view = render(
    <AttachmentCard
      file={html}
      storage={{ id: "h", state: "not_downloaded", progress: null }}
      onOpen={() => {}}
    />,
  );
  expect(screen.getByText("Not downloaded · 3.4 MB")).toBeTruthy();
  view.rerender(
    <AttachmentCard file={{ ...html, quarantined: true }} onOpen={() => {}} />,
  );
  expect(screen.getByText("Quarantined · 3.4 MB")).toBeTruthy();
  view.rerender(
    <AttachmentCard
      file={{ ...html, kind: "external_reference", uploaded_copy: false }}
      onOpen={() => {}}
    />,
  );
  expect(screen.getByText("Google Drive · External reference")).toBeTruthy();
  expect(screen.getByRole("button").textContent).toContain("HTML ↗");
});

test("an authored label names the card and the file name moves to the tooltip", () => {
  render(
    <AttachmentCard
      file={stored("l", "e2e-run.log")}
      label="Run log"
      onOpen={() => {}}
    />,
  );
  expect(screen.getByRole("button", { name: "Run log" })).toBeTruthy();
});

test("a long name gives way in the middle and keeps its end", () => {
  expect(fitName("refund.png")).toEqual({ text: "refund.png", cut: false });
  const long = "PSP Refunds API v3 — partial captures (signed) 2026-11-25.pdf";
  const { text, cut } = fitName(long);
  expect(cut).toBe(true);
  expect(text.endsWith(long.slice(-14))).toBe(true);
  expect(text).toContain("…" + long.slice(-14));
  expect(text.length).toBeLessThan(long.length);
});

test("a still is asked for only once the card is near the viewport", async () => {
  const arrive = viewport();
  const file = stored("img", "board.png");
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "attachment_workspace_id" ? "workspace" : info(file),
  );
  render(<AttachmentCard file={file} onOpen={() => {}} />);
  expect(invoke).not.toHaveBeenCalled();
  arrive();
  const picture = await screen.findByRole("presentation", { hidden: true });
  expect(picture.getAttribute("src")).toContain("/img");
  // A picture that fails to decode keeps the tile, silently.
  fireEvent.error(picture);
  expect(screen.queryByRole("presentation", { hidden: true })).toBeNull();
  expect(screen.getByRole("button").textContent).toContain("PNG");
});

test("an HTML report's still is the sanitised report in a sandboxed frame, read only when near", async () => {
  const arrive = viewport();
  const file = stored("report", "report.html", 2048);
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "attachment_workspace_id") return "workspace";
    if (command === "attachment_html")
      return '<h1 onclick="steal()">Refunds</h1><script>alert(1)</script><a href="https://x.test">go</a>';
    return null;
  });
  const { container } = render(
    <AttachmentCard file={file} onOpen={() => {}} />,
  );
  expect(invoke).not.toHaveBeenCalledWith("attachment_html", expect.anything());
  arrive();
  await waitFor(() => expect(container.querySelector("iframe")).toBeTruthy());
  const frame = container.querySelector("iframe")!;
  // No scripts, forms, popups or the app's origin: an empty sandbox.
  expect(frame.getAttribute("sandbox")).toBe("");
  expect(frame.getAttribute("aria-hidden")).toBe("true");
  const doc = frame.getAttribute("srcdoc") ?? "";
  expect(doc).toContain("Content-Security-Policy");
  expect(doc).toContain("Refunds");
  expect(doc).not.toContain("<script");
  expect(doc).not.toContain("onclick");
  expect(doc).not.toContain("https://x.test");
});

test("a report that can't show, a failed read, a large report or a missing file keep the tile", async () => {
  const arrive = viewport();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "attachment_workspace_id") return "workspace";
    const id = (args as { id: string }).id;
    if (id === "empty") return "<html><body></body></html>";
    throw new Error("unreadable");
  });
  const { container } = render(
    <>
      <AttachmentCard file={stored("empty", "empty.html")} onOpen={() => {}} />
      <AttachmentCard file={stored("bad", "bad.html")} onOpen={() => {}} />
      <AttachmentCard
        file={stored("big", "big.html", 3 * 1048576)}
        onOpen={() => {}}
      />
      <AttachmentCard
        file={stored("away", "away.html")}
        storage={{ id: "away", state: "not_downloaded", progress: null }}
        onOpen={() => {}}
      />
    </>,
  );
  arrive();
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("attachment_html", {
      workspace: "workspace",
      id: "bad",
    }),
  );
  await act(async () => {});
  expect(container.querySelector("iframe")).toBeNull();
  expect(invoke).not.toHaveBeenCalledWith(
    "attachment_html",
    expect.objectContaining({ id: "big" }),
  );
  expect(invoke).not.toHaveBeenCalledWith(
    "attachment_html",
    expect.objectContaining({ id: "away" }),
  );
  expect(screen.getAllByRole("button")).toHaveLength(4);
});

test("more than six cards fold into a +N card that opens the rest in place", () => {
  render(
    <FileGrid label="Files">
      {Array.from({ length: 13 }, (_, index) => (
        <li key={index} className="file-card-item">
          <AttachmentCard
            file={stored(`f${index}`, `file-${index}.zip`)}
            onOpen={() => {}}
          />
        </li>
      ))}
    </FileGrid>,
  );
  expect(screen.getAllByRole("listitem")).toHaveLength(7);
  expect(screen.queryByRole("button", { name: "file-6.zip" })).toBeNull();
  const more = screen.getByRole("button", { name: /Show all 13 files/ });
  expect(more.textContent).toContain("+7");
  fireEvent.click(more);
  expect(screen.getAllByRole("listitem")).toHaveLength(13);
  expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
  // Focus lands on the first card the +N card revealed.
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "file-6.zip" }),
  );
});
