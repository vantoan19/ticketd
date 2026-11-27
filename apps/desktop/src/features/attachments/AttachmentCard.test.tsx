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
import { openPdf } from "./pdf-document";
import { fakePdf } from "@/test/fake-pdf";
import type { Attachment } from "@/lib/api/attachments";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {},
  convertFileSrc: (value: string) =>
    `http://attachment-media.localhost/${value}`,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("./pdf-document", () => ({ openPdf: vi.fn() }));
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
  // Without Drive's details the card says only where the file is.
  expect(screen.getByText("Google Drive")).toBeTruthy();
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

test("measured, a cut name keeps the end of its second line and its first line stays whole", () => {
  // Seven pixels a letter: 21 letters fit a line of the card.
  const measure = (text: string) => text.length * 7;
  const name = "load-test-results-2026-11-25-checkout-captures-final.html";
  const fitted = fitName(name, measure);
  expect(fitted.cut).toBe(true);
  const [first, second] = fitted.lines!;
  expect(first).toBe("load-test-results-");
  expect(name.startsWith(first)).toBe(true);
  // The cut falls between words: the kept end starts at a word, whole.
  expect(second.endsWith("…final.html")).toBe(true);
  expect(measure(second)).toBeLessThanOrEqual(154);
  // A name that fits in two lines is not cut at all.
  expect(fitName("refund-after-fix-before-merge.png", measure).cut).toBe(false);
});

test("a wide-script name keeps its end from the second line, and the cut line still fits", () => {
  // CJK letters are twice as wide: 11 fit a line of the card.
  const measure = (text: string) =>
    [...text].reduce((sum, c) => sum + (c.charCodeAt(0) > 255 ? 14 : 7), 0);
  // 23 distinct letters: the first line takes 11, the other 12 do not fit under it.
  const name = Array.from({ length: 23 }, (_, i) =>
    String.fromCharCode(0x4e00 + i),
  ).join("");
  const fitted = fitName(name, measure);
  expect(fitted.cut).toBe(true);
  const [first, second] = fitted.lines!;
  const rest = name.slice(first.length);
  expect(measure(second)).toBeLessThanOrEqual(154);
  // Nothing of line one is repeated on line two.
  const [head, end] = second.split("…") as [string, string];
  expect(rest.startsWith(head) && rest.endsWith(end)).toBe(true);
  expect(head.length + end.length).toBeLessThan(rest.length);
});

test("a PDF's still is its first page as paper, and the caption gains the page count", async () => {
  const arrive = viewport();
  const file = stored("pdf", "refunds.pdf", 1.1 * 1048576);
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "attachment_workspace_id"
      ? "workspace"
      : new Uint8Array([37, 80, 68, 70]),
  );
  const pdf = fakePdf(12);
  vi.mocked(openPdf).mockResolvedValue(pdf.document);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
    "data:image/png;base64,AAAA",
  );
  render(<AttachmentCard file={file} onOpen={() => {}} />);
  // The tile and the plain caption come first; nothing is read until it is near.
  expect(screen.getByText("PDF · 1.1 MB")).toBeTruthy();
  expect(invoke).not.toHaveBeenCalledWith("attachment_pdf", expect.anything());
  arrive();
  const paper = await screen.findByRole("presentation", { hidden: true });
  expect(paper.getAttribute("src")).toBe("data:image/png;base64,AAAA");
  expect(paper.hasAttribute("data-paper")).toBe(true);
  expect(screen.getByText("PDF · 12 pages · 1.1 MB")).toBeTruthy();
  // Only the first page is drawn, small, and the parsed file is let go.
  expect(pdf.renders).toHaveLength(1);
  expect(pdf.renders[0]![0]).toBe(0);
  expect(pdf.renders[0]![1]).toBeCloseTo(240 / 612);
  expect(pdf.destroy).toHaveBeenCalled();
});

test("a PDF that could not be read is tried again, and nothing is asked before availability is known", async () => {
  const arrive = viewport();
  const file = stored("later", "later.pdf");
  let here = false;
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "attachment_workspace_id") return "workspace";
    if (!here) throw new Error("not downloaded yet");
    return new Uint8Array([37, 80, 68, 70]);
  });
  vi.mocked(openPdf).mockResolvedValue(fakePdf(2).document);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
    "data:image/png;base64,AAAA",
  );
  // Before the first availability answer the file may not be here: no read at all.
  const first = render(
    <AttachmentCard file={file} storageKnown={false} onOpen={() => {}} />,
  );
  arrive();
  await act(async () => {});
  expect(invoke).not.toHaveBeenCalledWith("attachment_pdf", expect.anything());
  // Known and present, but the read fails: the tile stays...
  first.rerender(<AttachmentCard file={file} onOpen={() => {}} />);
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("attachment_pdf", expect.anything()),
  );
  await act(async () => {});
  expect(first.container.querySelector("img")).toBeNull();
  first.unmount();
  // ...and when the file is here, the next card for it draws its page.
  here = true;
  render(<AttachmentCard file={file} onOpen={() => {}} />);
  arrive();
  const paper = await screen.findByRole("presentation", { hidden: true });
  expect(paper.hasAttribute("data-paper")).toBe(true);
});

test("a PDF that can't render, is large or isn't here keeps the tile", async () => {
  const arrive = viewport();
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "attachment_workspace_id"
      ? "workspace"
      : new Uint8Array([37, 80, 68, 70]),
  );
  vi.mocked(openPdf).mockRejectedValue(new Error("password"));
  const { container } = render(
    <>
      <AttachmentCard file={stored("bad", "locked.pdf")} onOpen={() => {}} />
      <AttachmentCard
        file={stored("big", "scan.pdf", 9 * 1048576)}
        onOpen={() => {}}
      />
      <AttachmentCard
        file={stored("away", "away.pdf")}
        storage={{ id: "away", state: "not_downloaded", progress: null }}
        onOpen={() => {}}
      />
    </>,
  );
  arrive();
  await waitFor(() => expect(openPdf).toHaveBeenCalledTimes(1));
  await act(async () => {});
  expect(container.querySelector("img")).toBeNull();
  for (const id of ["big", "away"])
    expect(invoke).not.toHaveBeenCalledWith(
      "attachment_pdf",
      expect.objectContaining({ id }),
    );
  expect(screen.getByText("PDF · 4 KB")).toBeTruthy();
  expect(screen.getAllByRole("button")).toHaveLength(3);
});

test("cards that left before their turn do not hold up the one still waiting behind them", async () => {
  const arrive = viewport();
  const releases = new Map<string, () => void>();
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command === "attachment_workspace_id")
      return Promise.resolve("workspace");
    const { id } = args as { id: string };
    // Only the report reads wait; anything else a card asks answers at once.
    if (command !== "attachment_html") return Promise.resolve(null);
    return new Promise((resolve) =>
      releases.set(id, () => resolve("<h1>Report</h1>")),
    );
  });
  const reads = () =>
    vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === "attachment_html")
      .map(([, args]) => (args as { id: string }).id);
  const card = (id: string) => (
    <AttachmentCard
      key={id}
      file={stored(id, `${id}.html`)}
      onOpen={() => {}}
    />
  );
  const ids = ["busy-a", "busy-b", "gone-c", "gone-d", "stays-e"];
  const view = render(<>{ids.map(card)}</>);
  arrive();
  // Two reads run at a time; the other three wait their turn.
  await waitFor(() => expect(reads()).toEqual(["busy-a", "busy-b"]));
  // Two of the waiting cards leave (a ticket switch, a folded list).
  view.rerender(<>{["busy-a", "busy-b", "stays-e"].map(card)}</>);
  await act(async () => {
    releases.get("busy-a")!();
    releases.get("busy-b")!();
  });
  // The one left waiting is read, though both turns went first to cards that were gone.
  await waitFor(() => expect(reads()).toContain("stays-e"));
  expect(reads()).not.toContain("gone-c");
  expect(reads()).not.toContain("gone-d");
  await act(async () => releases.get("stays-e")!());
});

test("a picture card asks for its file's facts once, not once for the still and once for Missing", async () => {
  const arrive = viewport();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "attachment_workspace_id") return "workspace";
    return info(stored("shot", "shot.png"));
  });
  render(
    <AttachmentCard file={stored("shot", "shot.png")} onOpen={() => {}} />,
  );
  arrive();
  await waitFor(() =>
    expect(document.querySelector("img.file-card-still")).not.toBeNull(),
  );
  const asked = (name: string) =>
    vi.mocked(invoke).mock.calls.filter(([command]) => command === name);
  expect(asked("attachment_preview")).toHaveLength(1);
  expect(asked("attachment_workspace_id")).toHaveLength(1);
});
