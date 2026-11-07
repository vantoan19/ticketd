// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { AttachmentThumbnail } from "./AttachmentThumbnail";

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
});

test("large images keep a file icon without automatically buffering preview bytes", () => {
  vi.mocked(invoke).mockResolvedValue("workspace");
  render(
    <AttachmentThumbnail
      file={{
        id: "large",
        display_name: "Large screenshot",
        original_filename: "large.png",
        size_bytes: 20 * 1024 * 1024,
        kind: "local_snapshot",
        locator: "large/bytes/large.png",
      }}
    />,
  );
  expect(invoke).not.toHaveBeenCalled();
});

test("only supported local images get a passive thumbnail, with a readable row after decoding fails", async () => {
  const file = {
    id: "image",
    display_name: "Screenshot",
    original_filename: "image.png",
    size_bytes: 4,
    kind: "local_snapshot" as const,
    locator: "image/bytes/image.png",
  };
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "attachment_workspace_id"
      ? "workspace"
      : {
          attachment: file,
          status: "available",
          media_type: "image/png",
          message: null,
          can_open: true,
          usage: { total: 0, legacy_drafts_pending: false, entries: [] },
        },
  );
  const view = render(<AttachmentThumbnail file={file} />);
  const image = await screen.findByRole("presentation", { hidden: true });
  expect(image.getAttribute("src")).toContain("/image");
  fireEvent.error(image);
  expect(screen.queryByRole("presentation", { hidden: true })).toBeNull();
  vi.mocked(invoke).mockClear();
  view.rerender(
    <AttachmentThumbnail file={{ ...file, original_filename: "unsafe.svg" }} />,
  );
  expect(vi.mocked(invoke)).not.toHaveBeenCalled();
});
