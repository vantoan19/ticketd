// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { AttachmentSettings } from "./AttachmentSettings";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

test("shows the core workspace limit and applies a new limit immediately with visible save failures", async () => {
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "attachment_upload_destination" ? { kind: "local" } : 104857600,
  );
  render(<AttachmentSettings />);
  const input = await screen.findByRole("spinbutton", {
    name: "Upload limit (MiB)",
  });
  await waitFor(() => expect((input as HTMLInputElement).value).toBe("100"));
  fireEvent.change(input, { target: { value: "25" } });
  fireEvent.blur(input);
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("set_attachment_upload_limit", {
      bytes: 26214400,
    }),
  );
  vi.mocked(invoke).mockRejectedValueOnce(new Error("Workspace is read-only"));
  fireEvent.change(input, { target: { value: "30" } });
  fireEvent.blur(input);
  await screen.findByText(/Workspace is read-only/);
  expect((input as HTMLInputElement).value).toBe("30");
});

test("destination preferences apply after writable selection and a failed change keeps the saved folder", async () => {
  const drive = {
    kind: "google_drive",
    destination: {
      connection_id: "account",
      folder_id: "folder",
      resource_key: null,
    },
    folder_name: "Team files",
  };
  let fail = false;
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "attachment_upload_limit") return 104857600;
    if (command === "attachment_upload_destination") return { kind: "local" };
    if (command === "drive_configuration")
      return { configured: true, message: "Ready" };
    if (command === "select_drive_upload_folder")
      return {
        destination: drive.destination,
        folder: { id: "folder", name: "Team files", can_add_children: true },
      };
    if (command === "set_attachment_upload_destination") {
      if (fail)
        throw new Error("Folder is read-only. Choose a writable folder.");
      return drive;
    }
    return null;
  });
  render(<AttachmentSettings />);
  const local = await screen.findByRole("radio", { name: /Local workspace/ });
  await waitFor(() => expect(local.getAttribute("data-state")).toBe("checked"));
  fireEvent.click(screen.getByRole("radio", { name: /Google Drive/ }));
  await screen.findByText("Team files");
  expect(
    screen.getByText(/Existing attachments stay where they are/),
  ).toBeTruthy();
  fail = true;
  fireEvent.click(screen.getByRole("button", { name: "Change folder" }));
  await screen.findByRole("alert");
  expect(screen.getByText("Team files")).toBeTruthy();
  expect(
    screen
      .getByRole("radio", { name: /Google Drive/ })
      .getAttribute("data-state"),
  ).toBe("checked");
});
