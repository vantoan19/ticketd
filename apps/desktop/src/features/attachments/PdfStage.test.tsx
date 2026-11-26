// @vitest-environment jsdom
import { useRef, type KeyboardEvent } from "react";
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
import { openPdf, PdfUnreadable } from "./pdf-document";
import { PdfStage } from "./PdfStage";
import { fakePdf } from "@/test/fake-pdf";
import type { Attachment } from "@/lib/api/attachments";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {},
  convertFileSrc: (value: string) => `http://localhost/${value}`,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("./pdf-document", () => ({
  openPdf: vi.fn(),
  PdfUnreadable: class PdfUnreadable extends Error {},
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const file: Attachment = {
  id: "pdf-1",
  display_name: "Refunds API",
  original_filename: "refunds.pdf",
  size_bytes: 2048,
  kind: "local_snapshot",
  locator: "pdf-1/bytes/refunds.pdf",
};

/** A scrolling stage the test controls: jsdom has no layout. */
function Stage({ onRetry = () => {} }: { onRetry?: () => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const keys = useRef<((event: KeyboardEvent) => void) | null>(null);
  return (
    <div
      ref={scroller}
      data-testid="stage"
      tabIndex={-1}
      onKeyDown={(event) => keys.current?.(event)}
    >
      <PdfStage
        workspace="workspace"
        file={file}
        attempt={0}
        onRetry={onRetry}
        scrollerRef={scroller}
        keysRef={keys}
      />
    </div>
  );
}
function scrollable() {
  const stage = screen.getByTestId("stage");
  let top = 0;
  const to = (value: number) => (top = value);
  Object.defineProperty(stage, "scrollTop", {
    get: () => top,
    set: (value: number) => {
      top = value;
    },
  });
  Object.defineProperty(stage, "clientHeight", { get: () => 600 });
  // The column scrolls up with the stage: its top is minus the scroll position.
  const column = stage.querySelector(".attachment-pdf")!;
  column.getBoundingClientRect = () => ({ top: -top }) as DOMRect;
  return { stage, top: () => top, to };
}
function serve(pages: number) {
  const pdf = fakePdf(pages);
  vi.mocked(invoke).mockImplementation(async () => new Uint8Array([37, 80]));
  vi.mocked(openPdf).mockResolvedValue(pdf.document);
  return pdf;
}

test("a multi-page PDF shows its pages, a page number and a zoom, and reads through the checked read", async () => {
  const pdf = serve(12);
  render(<Stage />);
  expect(await screen.findByRole("img", { name: "Page 1" })).toBeTruthy();
  expect(screen.getAllByRole("img")).toHaveLength(12);
  expect(invoke).toHaveBeenCalledWith("attachment_pdf", {
    workspace: "workspace",
    id: "pdf-1",
  });
  expect(
    screen.getByRole<HTMLInputElement>("textbox", { name: "Page" }).value,
  ).toBe("1");
  expect(screen.getByText("of 12")).toBeTruthy();
  // Fit is on, and fits the page width up to 125%.
  expect(screen.getByText("125%")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Fit" }).getAttribute("aria-pressed"),
  ).toBe("true");
  await waitFor(() => expect(pdf.renders.length).toBe(12));
  expect(pdf.renders[0]).toEqual([0, 1.25]);
});

test("zoom steps through levels, leaves Fit, and + - 0 do the same from the stage", async () => {
  const pdf = serve(3);
  render(<Stage />);
  await screen.findByRole("img", { name: "Page 1" });
  const fit = screen.getByRole("button", { name: "Fit" });
  fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
  expect(screen.getByText("110%")).toBeTruthy();
  expect(fit.getAttribute("aria-pressed")).toBe("false");
  await waitFor(() =>
    expect(pdf.renders.some(([, s]) => s === 1.1)).toBe(true),
  );
  const stage = screen.getByTestId("stage");
  fireEvent.keyDown(stage, { key: "+" });
  expect(screen.getByText("125%")).toBeTruthy();
  fireEvent.keyDown(stage, { key: "-" });
  fireEvent.keyDown(stage, { key: "-" });
  expect(screen.getByText("100%")).toBeTruthy();
  fireEvent.keyDown(stage, { key: "0" });
  expect(fit.getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByText("125%")).toBeTruthy();
  // The app's own zoom (Cmd +) and the file-switching keys are left alone.
  const before = pdf.renders.length;
  fireEvent.keyDown(stage, { key: "+", metaKey: true });
  fireEvent.keyDown(stage, { key: "j" });
  fireEvent.keyDown(stage, { key: "k" });
  expect(screen.getByText("125%")).toBeTruthy();
  expect(pdf.renders.length).toBe(before);
});

test("the page number follows the scroll, and typing a number jumps to that page", async () => {
  serve(12);
  render(<Stage />);
  await screen.findByRole("img", { name: "Page 1" });
  const stage = scrollable();
  const field = screen.getByRole<HTMLInputElement>("textbox", { name: "Page" });
  // Pages are 990px tall at 125%, 16px apart; this view sits on page 3.
  stage.to(2100);
  fireEvent.scroll(stage.stage);
  await waitFor(() => expect(field.value).toBe("3"));
  fireEvent.change(field, { target: { value: "5" } });
  fireEvent.keyDown(field, { key: "Enter" });
  expect(stage.top()).toBe(16 + 4 * (990 + 16) - 16);
  expect(field.value).toBe("5");
  // Out of range stops at the last page.
  fireEvent.change(field, { target: { value: "99" } });
  fireEvent.keyDown(field, { key: "Enter" });
  await waitFor(() => expect(field.value).toBe("12"));
  // Typing a letter never moves the page or the zoom.
  fireEvent.keyDown(field, { key: "0" });
  expect(screen.getByText("125%")).toBeTruthy();
  const next = screen.getByRole<HTMLButtonElement>("button", {
    name: "Next page",
  });
  expect(next.disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
  expect(field.value).toBe("11");
});

test("a render that was cancelled by a zoom never replaces the newer canvas", async () => {
  const pdf = serve(1);
  const canvases: HTMLCanvasElement[] = [];
  const finish: Array<() => void> = [];
  pdf.document.render = (_index, canvas) => {
    canvases.push(canvas);
    // Cancelling does not reject: `done` still resolves, as it does for pdf.js.
    return {
      done: new Promise<void>((resolve) => finish.push(resolve)),
      cancel() {},
    };
  };
  render(<Stage />);
  const page = await screen.findByRole("img", { name: "Page 1" });
  await waitFor(() => expect(canvases).toHaveLength(1));
  fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
  await waitFor(() => expect(canvases).toHaveLength(2));
  await act(async () => {
    finish[1]!();
    finish[0]!();
  });
  expect(page.querySelectorAll("canvas")).toHaveLength(1);
  expect(page.querySelector("canvas")).toBe(canvases[1]);
});

test("a one-page PDF has a zoom but no page controls", async () => {
  serve(1);
  render(<Stage />);
  await screen.findByRole("img", { name: "Page 1" });
  expect(screen.queryByRole("textbox", { name: "Page" })).toBeNull();
  expect(screen.getByRole("button", { name: "Zoom in" })).toBeTruthy();
});

test("a PDF that can't render says so, with no detail, and never shows the bar", async () => {
  vi.mocked(invoke).mockResolvedValue(new Uint8Array([1]));
  vi.mocked(openPdf).mockRejectedValue(new PdfUnreadable());
  render(<Stage />);
  expect(await screen.findByText("Couldn't show this PDF")).toBeTruthy();
  expect(
    screen.getByText(
      "It may be damaged or password-protected. Open it in its app.",
    ),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Fit" })).toBeNull();
});

test("a PDF that can't be read from the stored copy offers Retry", async () => {
  const onRetry = vi.fn();
  vi.mocked(invoke).mockRejectedValue(new Error("This file is not a PDF."));
  render(<Stage onRetry={onRetry} />);
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  expect(onRetry).toHaveBeenCalledOnce();
  expect(openPdf).not.toHaveBeenCalled();
});

test("leaving the PDF lets go of the parsed document", async () => {
  const pdf = serve(2);
  const view = render(<Stage />);
  await screen.findByRole("img", { name: "Page 1" });
  view.unmount();
  await act(async () => {});
  expect(pdf.destroy).toHaveBeenCalled();
});
