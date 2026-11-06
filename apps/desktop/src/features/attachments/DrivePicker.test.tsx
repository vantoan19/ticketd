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
import { AttachmentPicker } from "./AttachmentPicker";
import { AttachmentLink } from "./AttachmentLink";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
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

test("shared picker selects Drive references without changing local upload destination", async () => {
  vi.mocked(invoke).mockImplementation(async (command) => {
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

test("native references offer Open in Drive and describe current content without byte export", async () => {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "resolve_attachment_uri") return file;
    return undefined;
  });
  render(
    <AttachmentLink uri="ticketd://attachment/workspace/drive-1">
      My label
    </AttachmentLink>,
  );
  fireEvent.click(screen.getByRole("button", { name: "My label" }));
  expect(await screen.findByText(/Current source content/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Export file" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open in Drive" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("open_attachment", { id: "drive-1" }),
  );
});

test("mixed insertion results retain failed identity and retry before the later successful file", async () => {
  const second = { ...file, id: "drive-2", display_name: "Current sheet" };
  vi.mocked(invoke).mockImplementation(async (command) => {
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
