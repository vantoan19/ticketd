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
import { DriveAccessRecovery } from "./DriveAccessRecovery";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const reference = {
  connection_id: "opaque-account",
  metadata: {
    id: "file",
    name: "Last-known plan",
    mime_type: "text/plain",
    size_bytes: 4,
    web_url: "https://drive.google.com/file/d/file/view",
    resource_key: null,
  },
};

test("per-file authorization uses recovery Picker and refreshes without replacing the reference", async () => {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "drive_configuration")
      return { configured: true, message: "Ready" };
    if (command === "check_drive_reference")
      return {
        reference,
        failure: {
          kind: "select_file",
          message: "Select the original file in Picker",
        },
      };
    if (command === "recover_drive_reference")
      return { reference, failure: null };
    throw new Error(`Unexpected command ${command}`);
  });
  const refreshed = vi.fn();
  render(<DriveAccessRecovery id="attachment" onRefresh={refreshed} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Authorize file" }),
  );
  await screen.findByText("Current source in Google Drive");
  expect(invoke).toHaveBeenCalledWith("recover_drive_reference", {
    id: "attachment",
    operationId: expect.any(String),
  });
  expect(refreshed).toHaveBeenCalledOnce();
  expect(invoke).not.toHaveBeenCalledWith(
    "select_drive_files",
    expect.anything(),
  );
});

test("offline retry and denied guidance preserve uncertainty and use no automatic byte download", async () => {
  let kind = "offline";
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "drive_configuration")
      return { configured: true, message: "Ready" };
    if (command === "check_drive_reference")
      return {
        reference,
        failure: { kind, message: "Last-known details are retained" },
      };
    throw new Error(`Unexpected command ${command}`);
  });
  render(<DriveAccessRecovery id="attachment" onRefresh={() => {}} />);
  await screen.findByText("Google Drive is unavailable");
  kind = "inaccessible_or_missing";
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("Access or availability is uncertain");
  expect(screen.getByText(/request access from its owner/)).toBeTruthy();
  kind = "permission_denied";
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("Drive permission denied");
  expect(invoke).not.toHaveBeenCalledWith("open_attachment", expect.anything());
});

test("unmount cancels an active recovery and ignores its late completion", async () => {
  let finish: ((value: unknown) => void) | undefined;
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "drive_configuration")
      return { configured: true, message: "Ready" };
    if (command === "check_drive_reference")
      return {
        reference,
        failure: { kind: "reauthorize", message: "Reconnect" },
      };
    if (command === "recover_drive_reference")
      return new Promise((resolve) => {
        finish = resolve;
      });
    if (command === "cancel_drive_selection") return;
    throw new Error(`Unexpected command ${command}`);
  });
  const refreshed = vi.fn();
  const view = render(
    <DriveAccessRecovery id="attachment" onRefresh={refreshed} />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Reconnect" }));
  await screen.findByRole("button", { name: "Cancel selection" });
  view.unmount();
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("cancel_drive_selection", {
      operationId: expect.any(String),
    }),
  );
  finish?.({ reference, failure: null });
  expect(refreshed).not.toHaveBeenCalled();
});
