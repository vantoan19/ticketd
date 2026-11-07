// @vitest-environment jsdom
import { IDBFactory } from "fake-indexeddb";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { AttachmentPicker } from "./AttachmentPicker";
import { AttachmentLink } from "./AttachmentLink";
import { AttachmentPreview } from "./AttachmentPreview";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => path,
  Channel: class {
    onmessage = () => {};
  },
}));
beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
});
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const file = {
  id: "drive-1",
  display_name: "Current plan",
  original_filename: "Current plan",
  kind: "external_reference",
  size_bytes: null,
  locator: "drive:connection:doc-1",
};

test("unconfigured Drive keeps setup details collapsed and local sources usable", async () => {
  const diagnostic =
    "Set TICKETD_GOOGLE_OAUTH_CLIENT_FILE to a Desktop OAuth client JSON";
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "attachment_workspace_id") return "drive-test-workspace";
    if (command === "attachment_upload_limit") return 104857600;
    if (command === "drive_configuration")
      return { configured: false, message: diagnostic };
    throw new Error(`Unexpected command ${command}`);
  });
  render(<AttachmentPicker open onOpenChange={vi.fn()} onPick={vi.fn()} />);
  fireEvent.click(screen.getByRole("radio", { name: "Google Drive" }));
  expect(await screen.findByRole("status")).toHaveProperty(
    "textContent",
    "Google Drive setup is required before connecting.",
  );
  const instructions = screen.getByText(diagnostic).closest("details");
  expect(instructions).not.toBeNull();
  expect(instructions?.open).toBe(false);
  fireEvent.click(screen.getByText("Setup instructions", { exact: true }));
  expect(instructions?.open).toBe(true);
  expect(
    screen
      .getByRole("button", { name: "Choose in Google Drive" })
      .hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(screen.getByRole("radio", { name: "Upload" }));
  expect(screen.getByRole("button", { name: "Choose files" })).toBeTruthy();
  expect(invoke).not.toHaveBeenCalledWith(
    "select_drive_files",
    expect.anything(),
  );
});

test("choosing an upload folder shows typed setup guidance collapsed while local capture stays usable", async () => {
  const diagnostic =
    "Set TICKETD_GOOGLE_OAUTH_CLIENT_FILE to a Desktop OAuth client JSON";
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "attachment_workspace_id") return "upload-setup-workspace";
    if (command === "attachment_upload_limit") return 104857600;
    if (command === "drive_configuration")
      return { configured: false, message: diagnostic };
    throw new Error(`Unexpected command ${command}`);
  });
  render(<AttachmentPicker open onOpenChange={vi.fn()} onPick={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Choose Drive folder" }));
  expect(await screen.findByRole("status")).toHaveProperty(
    "textContent",
    "Google Drive setup is required before connecting.",
  );
  const details = screen.getByText(diagnostic).closest("details");
  expect(details?.open).toBe(false);
  expect(
    screen
      .getByRole("button", { name: "Choose files" })
      .hasAttribute("disabled"),
  ).toBe(false);
  expect(invoke).not.toHaveBeenCalledWith(
    "select_drive_upload_folder",
    expect.anything(),
  );
  fireEvent.click(screen.getByText("Setup instructions", { exact: true }));
  expect(details?.open).toBe(true);
  expect(screen.getByText(diagnostic)).toBeTruthy();
});

test("shared picker selects Drive references without changing local upload destination", async () => {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "attachment_workspace_id") return "drive-test-workspace";
    if (command === "attachment_upload_limit") return 104857600;
    if (command === "drive_configuration")
      return { configured: true, message: "Ready to select files" };
    if (command === "select_drive_files")
      return { files: [file], failures: [] };
    throw new Error(`Unexpected command ${command}`);
  });
  const picked = vi.fn().mockResolvedValue(undefined);
  render(<AttachmentPicker open onOpenChange={vi.fn()} onPick={picked} />);
  fireEvent.click(screen.getByRole("radio", { name: "Google Drive" }));
  expect(await screen.findByText(/Only files you select/)).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Choose in Google Drive" }),
  );
  await screen.findByRole("checkbox", { name: "Current plan" });
  expect(picked).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Add selected" }));
  await waitFor(() =>
    expect(picked).toHaveBeenCalledWith(file, expect.any(String)),
  );
});

test.each(["inline", "library"])(
  "%s native references offer Open in Drive and describe current content without byte export",
  async (entry) => {
    vi.mocked(open).mockResolvedValue("C:/sharing");
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "attachment_workspace_id") return "drive-test-workspace";
      if (command === "attachment_upload_limit") return 104857600;
      if (command === "resolve_attachment_uri") return file;
      if (command === "attachment_preview")
        return {
          attachment: file,
          status: "unsupported",
          media_type: null,
          message: "Current source content · No local snapshot.",
          can_open: true,
          usage: { total: 0, entries: [], legacy_drafts_pending: false },
        };
      if (command === "drive_reference")
        return {
          connection_id: "connection",
          metadata: {
            id: "doc-1",
            name: "Current plan",
            mime_type: "application/vnd.google-apps.document",
            size_bytes: null,
            web_url: "https://docs.google.com/document/d/doc-1/edit",
            resource_key: null,
          },
        };
      if (command === "export_markdown_with_files")
        return {
          format_version: 1,
          status: "complete",
          directory: "C:/sharing/export",
          markdown_path: "content.md",
          manifest_path: "manifest.json",
          attachments: [
            {
              uri: "ticketd://attachment/drive-test-workspace/drive-1",
              attachment_id: "drive-1",
              kind: "external_reference",
              display_name: "Current plan",
              original_filename: "Current plan",
              path: null,
              external_url: "https://docs.google.com/document/d/doc-1/edit",
              omission: null,
            },
          ],
        };
      return undefined;
    });
    if (entry === "inline") {
      render(
        <AttachmentLink uri="ticketd://attachment/workspace/drive-1">
          My label
        </AttachmentLink>,
      );
      fireEvent.click(screen.getByRole("button", { name: "My label" }));
    } else {
      render(
        <AttachmentPreview
          target={{
            id: file.id,
            initial: { ...file, kind: "external_reference" },
          }}
          onClose={vi.fn()}
        />,
      );
    }
    expect(await screen.findByText(/Current source content/)).toBeTruthy();
    expect(await screen.findByText("Google Docs")).toBeTruthy();
    expect(screen.getByText("Size unavailable")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Export file" })).toBeNull();
    expect(document.querySelector("img,video,audio,iframe,object")).toBeNull();
    if (entry === "library")
      expect(invoke).not.toHaveBeenCalledWith(
        "resolve_attachment_uri",
        expect.anything(),
      );
    fireEvent.click(screen.getByRole("button", { name: "Open in Drive" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("open_attachment", { id: "drive-1" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Export link" }));
    await screen.findByRole("dialog", { name: "Export complete" });
    expect(invoke).toHaveBeenCalledWith("export_markdown_with_files", {
      source: {
        kind: "markdown",
        body: "<ticketd://attachment/drive-test-workspace/drive-1>",
      },
      output: "C:/sharing",
    });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Export link" }),
      ),
    );
  },
);

test("mixed insertion results retain failed identity and retry before the later successful file", async () => {
  const second = { ...file, id: "drive-2", display_name: "Current sheet" };
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "attachment_workspace_id") return "drive-test-workspace";
    if (command === "attachment_upload_limit") return 104857600;
    if (command === "drive_configuration")
      return { configured: true, message: "Ready" };
    if (command === "select_drive_files")
      return { files: [file, second], failures: [] };
    throw new Error(`Unexpected command ${command}`);
  });
  const picked = vi
    .fn()
    .mockRejectedValueOnce(new Error("Reference save failed"))
    .mockResolvedValue(undefined);
  const close = vi.fn();
  render(<AttachmentPicker open onOpenChange={close} onPick={picked} />);
  fireEvent.click(screen.getByRole("radio", { name: "Google Drive" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Choose in Google Drive" }),
  );
  await screen.findByRole("checkbox", { name: "Current sheet" });
  fireEvent.click(screen.getByRole("button", { name: "Add selected" }));
  await waitFor(() => expect(picked).toHaveBeenCalledTimes(2));
  expect(close).not.toHaveBeenCalled();
  const requestId = picked.mock.calls[0]?.[1];
  expect(await screen.findByRole("alert")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Add selected" }));
  await waitFor(() =>
    expect(picked).toHaveBeenLastCalledWith(file, requestId, "drive-2"),
  );
  expect(close).toHaveBeenCalledWith(false);
});

test("closing during browser selection cancels the operation and late results never insert", async () => {
  let finish: (value: unknown) => void = () => {};
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "attachment_workspace_id") return "drive-test-workspace";
    if (command === "attachment_upload_limit") return 104857600;
    if (command === "drive_configuration")
      return { configured: true, message: "Ready" };
    if (command === "select_drive_files")
      return new Promise((resolve) => {
        finish = resolve;
      });
    if (command === "cancel_drive_selection") return undefined;
    throw new Error(`Unexpected command ${command}`);
  });
  const picked = vi.fn();
  const { rerender } = render(
    <AttachmentPicker open onOpenChange={vi.fn()} onPick={picked} />,
  );
  fireEvent.click(screen.getByRole("radio", { name: "Google Drive" }));
  const choose = await screen.findByRole("button", {
    name: "Choose in Google Drive",
  });
  await waitFor(() => expect(choose.hasAttribute("disabled")).toBe(false));
  fireEvent.click(choose);
  await screen.findByRole("button", { name: "Cancel Drive selection" });
  rerender(
    <AttachmentPicker open={false} onOpenChange={vi.fn()} onPick={picked} />,
  );
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("cancel_drive_selection", {
      operationId: expect.any(String),
    }),
  );
  await act(async () => finish({ files: [file], failures: [] }));
  expect(picked).not.toHaveBeenCalled();
});

test("reference replacement refuses multiple Drive choices before changing the selected reference", async () => {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "attachment_workspace_id") return "workspace";
    if (command === "attachment_upload_limit") return 104857600;
    if (command === "drive_configuration")
      return { configured: true, message: "Ready" };
    if (command === "select_drive_files")
      return {
        files: [file, { ...file, id: "drive-2", display_name: "Second plan" }],
        failures: [],
      };
    throw new Error(command);
  });
  const picked = vi.fn().mockResolvedValue(undefined);
  render(
    <AttachmentPicker open single onOpenChange={vi.fn()} onPick={picked} />,
  );
  fireEvent.click(screen.getByRole("radio", { name: "Google Drive" }));
  const choose = await screen.findByRole("button", {
    name: "Choose in Google Drive",
  });
  await waitFor(() => expect(choose.hasAttribute("disabled")).toBe(false));
  fireEvent.click(choose);
  await screen.findByRole("checkbox", { name: "Second plan" });
  fireEvent.click(screen.getByRole("button", { name: "Add selected" }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Choose exactly one file to replace this reference.",
  );
  expect(picked).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("checkbox", { name: "Second plan" }));
  fireEvent.click(screen.getByRole("button", { name: "Add selected" }));
  await waitFor(() =>
    expect(picked).toHaveBeenCalledWith(file, expect.any(String)),
  );
});
