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
import { AttachmentPreview } from "./AttachmentPreview";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string, protocol: string) =>
    `${protocol}://localhost/${path}`,
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

test("closing pending inspection ignores its late response and media close releases playback", async () => {
  let complete: ((value: unknown) => void) | undefined;
  const pending = new Promise((resolve) => {
    complete = resolve;
  });
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "attachment_workspace_id" ? "workspace" : pending,
  );
  const view = render(
    <AttachmentPreview
      target={{ id: file.id, initial: file }}
      onClose={() => {}}
    />,
  );
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("attachment_preview", {
      workspace: "workspace",
      id: file.id,
    }),
  );
  view.unmount();
  await act(async () =>
    complete?.({
      attachment: file,
      status: "available",
      media_type: "video/mp4",
      message: null,
      can_open: true,
    }),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  const pause = vi
    .spyOn(HTMLMediaElement.prototype, "pause")
    .mockImplementation(() => {});
  const load = vi
    .spyOn(HTMLMediaElement.prototype, "load")
    .mockImplementation(() => {});
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "attachment_workspace_id"
      ? "workspace"
      : {
          attachment: file,
          status: "available",
          media_type: "video/mp4",
          message: null,
          can_open: true,
        },
  );
  const playing = render(
    <AttachmentPreview target={{ id: file.id }} onClose={() => {}} />,
  );
  const video = await screen.findByLabelText("Screenshot", {
    selector: "video",
  });
  expect(video.getAttribute("autoplay")).toBeNull();
  expect(video.getAttribute("preload")).toBe("metadata");
  playing.unmount();
  expect(video.hasAttribute("src")).toBe(false);
  expect(pause).toHaveBeenCalledOnce();
  expect(load).toHaveBeenCalledOnce();
});

const file = {
  id: "file-1",
  display_name: "Screenshot",
  original_filename: "screen.png",
  size_bytes: 32,
  kind: "local_snapshot" as const,
  locator: "file-1/bytes/screen.png",
};

test("a failed image retains metadata and explicit actions, with retry instead of an invented cause", async () => {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "attachment_workspace_id") return "workspace";
    if (command === "attachment_preview")
      return {
        attachment: file,
        status: "available",
        media_type: "image/png",
        message: null,
        can_open: true,
      };
    return null;
  });
  render(
    <AttachmentPreview
      target={{ id: file.id, initial: file }}
      onClose={() => {}}
    />,
  );
  const image = await screen.findByRole("img", { name: "Screenshot" });
  expect(image.getAttribute("src")).toBe(
    "attachment-media://localhost/workspace/file-1",
  );
  fireEvent.error(image);
  expect(await screen.findByText("Preview unavailable")).toBeTruthy();
  expect(screen.getByText("screen.png")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Export file" })).toBeTruthy();
  expect(invoke).not.toHaveBeenCalledWith("open_attachment", expect.anything());
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByRole("img", { name: "Screenshot" });
  fireEvent.click(screen.getByRole("button", { name: "Open file" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("open_attachment", { id: file.id }),
  );
});
