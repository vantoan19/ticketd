import { StrictMode } from "react";
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
      usage: { total: 0, entries: [], legacy_drafts_pending: false },
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
          usage: { total: 0, entries: [], legacy_drafts_pending: false },
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

test("Drive access refresh updates displayed metadata while preserving the authored title and open action", async () => {
  let size = 4;
  const remote = {
    ...file,
    kind: "external_reference",
    display_name: "My authored title",
    size_bytes: size,
  };
  const metadata = () => ({
    connection_id: "opaque-account",
    metadata: {
      id: "remote-file",
      name: "Current source name",
      mime_type: "text/plain",
      size_bytes: size,
      web_url: "https://drive.google.com/file/d/remote-file/view",
      resource_key: null,
    },
  });
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "attachment_workspace_id") return "workspace";
    if (command === "attachment_preview")
      return {
        attachment: { ...remote, size_bytes: size },
        status: "unsupported",
        media_type: null,
        message: "No local snapshot",
        can_open: true,
        usage: { total: 0, entries: [], legacy_drafts_pending: false },
      };
    if (command === "drive_reference") return metadata();
    if (command === "drive_configuration")
      return { configured: true, message: "Ready" };
    if (command === "check_drive_reference") {
      size = 8;
      return { reference: metadata(), failure: null };
    }
    if (command === "open_attachment") return;
    throw new Error(`Unexpected command ${command}`);
  });
  render(<AttachmentPreview target={{ id: remote.id }} onClose={() => {}} />);
  await screen.findByText("Current source in Google Drive");
  await screen.findByText("Google Drive · External reference · 8 B");
  expect(
    screen.getByRole("heading", { name: "My authored title" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open in Drive" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("open_attachment", { id: remote.id }),
  );
});

test("quarantined content offers explicit same-identity restore without replacing a reference", async () => {
  let quarantined = true;
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "attachment_workspace_id") return "workspace";
    if (command === "restore_attachment") {
      quarantined = false;
      return { ...file, quarantined };
    }
    if (command === "attachment_preview")
      return {
        attachment: { ...file, quarantined },
        status: "unsupported",
        media_type: null,
        message: "No media preview",
        can_open: true,
        usage: { total: 0, entries: [], legacy_drafts_pending: false },
      };
    throw new Error(`Unexpected ${command}`);
  });
  render(<AttachmentPreview target={{ id: file.id }} onClose={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "Restore file" }));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Restore file" })).toBeNull(),
  );
  expect(screen.getByRole("dialog", { name: "Screenshot" })).toBeTruthy();
});

test("usage distinguishes persisted context, recoverable trash and Undo alongside missing metadata", async () => {
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "attachment_workspace_id"
      ? "workspace"
      : {
          attachment: file,
          status: "missing",
          media_type: null,
          message: "Stored bytes are missing",
          can_open: false,
          usage: {
            total: 3,
            legacy_drafts_pending: false,
            entries: [
              {
                kind: "ticket_body",
                owner: "t1",
                label: "T-1 · Checkout failure",
                trashed: false,
              },
              {
                kind: "document_body",
                owner: "d1",
                label: "Incident analysis",
                trashed: true,
              },
              {
                kind: "undo",
                owner: "history",
                label: "Undo history",
                trashed: false,
              },
            ],
          },
        },
  );
  render(
    <AttachmentPreview
      target={{ id: file.id, initial: file }}
      onClose={() => {}}
    />,
  );
  await screen.findByRole("heading", { name: "Used in 3" });
  expect(screen.getByText("T-1 · Checkout failure")).toBeTruthy();
  expect(screen.getByText("Incident analysis")).toBeTruthy();
  expect(screen.getByText(/Document · Trash/)).toBeTruthy();
  expect(screen.getByText("Undo history")).toBeTruthy();
});

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
        usage: { total: 0, entries: [], legacy_drafts_pending: false },
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

test.each(["image/png", "video/mp4"])(
  "Strict Mode restores %s sources after its effect cleanup rehearsal",
  async (mime) => {
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    vi.mocked(invoke).mockImplementation(async (command) =>
      command === "attachment_workspace_id"
        ? "workspace"
        : {
            attachment: file,
            status: "available",
            media_type: mime,
            message: null,
            can_open: true,
            usage: { total: 0, entries: [], legacy_drafts_pending: false },
          },
    );
    const view = render(
      <StrictMode>
        <AttachmentPreview target={{ id: file.id }} onClose={() => {}} />
      </StrictMode>,
    );
    const element = mime.startsWith("image")
      ? await screen.findByRole("img", { name: "Screenshot" })
      : await screen.findByLabelText("Screenshot", { selector: "video" });
    expect(element.getAttribute("src")).toContain(
      "attachment-media://localhost/workspace/file-1",
    );
    view.unmount();
    expect(element.hasAttribute("src")).toBe(false);
  },
);
