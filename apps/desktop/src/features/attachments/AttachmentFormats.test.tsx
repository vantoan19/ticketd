// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { AttachmentPreview } from "./AttachmentPreview";
import type { Attachment } from "@/lib/api/attachments";
import { setPreference } from "@/lib/preferences";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string, protocol: string) =>
    `${protocol}://localhost/${path}`,
}));
beforeEach(() => setPreference("attachmentDetails", false));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function stored(name: string, size: number): Attachment {
  return {
    id: "f-1",
    display_name: name,
    original_filename: name,
    size_bytes: size,
    kind: "local_snapshot",
    locator: `f-1/bytes/${name}`,
  };
}
function serve(file: Attachment, facts: Record<string, unknown>, text = "") {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "attachment_workspace_id") return "workspace";
    if (command === "attachment_preview")
      return {
        attachment: file,
        status: "unsupported",
        media_type: null,
        message: null,
        can_open: true,
        usage: { total: 0, entries: [], legacy_drafts_pending: false },
        ...facts,
      };
    if (command === "attachment_text") return new TextEncoder().encode(text);
    if (command === "attachment_text_first_line") return 1;
    return null;
  });
}
const whole = (bytes: number) => ({
  text_excerpt: { text: "", truncated: false },
  text: { total_bytes: bytes, shown_bytes: bytes, partial: false },
});

test("an SVG shows as a picture drawn by an image, never as a document or as source", async () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><script>alert(1)</script><rect width="40" height="20"/></svg>';
  const file = stored("logo.svg", svg.length);
  serve(file, whole(svg.length), svg);
  render(<AttachmentPreview target={{ id: file.id }} onClose={() => {}} />);
  const picture = await screen.findByRole<HTMLImageElement>("img", {
    name: "logo.svg",
  });
  await waitFor(() =>
    expect(picture.getAttribute("src")).toMatch(/^data:image\/svg\+xml/),
  );
  expect(decodeURIComponent(picture.getAttribute("src")!)).toContain("<rect");
  // It is the picture's zoom bar, not the log's line numbers and Find.
  expect(screen.getByRole("button", { name: "Fit" })).toBeTruthy();
  expect(screen.queryByRole("document", { name: /Text of/ })).toBeNull();
  expect(document.querySelector("iframe, object, embed")).toBeNull();
});

test("an SVG over the picture limit stays source text", async () => {
  const file = stored("map.svg", 6 * 1024 * 1024);
  serve(file, whole(file.size_bytes!), "<svg/>");
  render(<AttachmentPreview target={{ id: file.id }} onClose={() => {}} />);
  await screen.findByRole("document", { name: /map\.svg/ });
  expect(screen.queryByRole("img", { name: "map.svg" })).toBeNull();
});

test("a file with no bytes says it is empty, in the state block", async () => {
  const file = stored("empty.log", 0);
  serve(file, whole(0));
  render(<AttachmentPreview target={{ id: file.id }} onClose={() => {}} />);
  expect(await screen.findByText("Empty file")).toBeTruthy();
  expect(
    screen.getByText("It has no content, so there’s nothing to show."),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Wrap lines" })).toBeNull();
});

test("a picture with too many pixels says so instead of quoting its small size", async () => {
  const file = stored("sky.png", 195 * 1024);
  serve(file, { status: "too_large", message: "Image dimensions exceed" });
  render(<AttachmentPreview target={{ id: file.id }} onClose={() => {}} />);
  expect(await screen.findByText("Too large to preview")).toBeTruthy();
  expect(
    screen.getByText(
      "Its picture has too many pixels to show here. Open it in its app to see it.",
    ),
  ).toBeTruthy();
  expect(screen.queryByText(/195 KB/)).toBeNull();
});

test("a file too large by its size still quotes the size", async () => {
  const file = stored("huge.png", 120 * 1024 * 1024);
  serve(file, { status: "too_large" });
  render(<AttachmentPreview target={{ id: file.id }} onClose={() => {}} />);
  expect(await screen.findByText(/^It’s 1\d\d MB\./)).toBeTruthy();
});
