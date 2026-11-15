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
import { SettingsStateContext, type SettingsState } from "./use-settings-state";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const drive = {
  kind: "google_drive",
  destination: {
    connection_id: "account",
    folder_id: "folder",
    resource_key: null,
  },
  folder_name: "Team files",
};

/** Answers the commands the page sends; `overrides` replace single answers. */
function answer(overrides: Record<string, unknown> = {}) {
  const answers: Record<string, unknown> = {
    attachment_upload_limit: 104857600,
    attachment_upload_destination: { kind: "local" },
    drive_configuration: { configured: true, message: "Ready" },
    select_drive_upload_folder: {
      destination: drive.destination,
      folder: { id: "folder", name: "Team files", can_add_children: true },
    },
    set_attachment_upload_destination: drive,
    set_attachment_upload_limit: null,
    ...overrides,
  };
  vi.mocked(invoke).mockImplementation(async (command) => {
    const value = answers[command];
    if (value instanceof Error) throw value;
    return value ?? null;
  });
}

const limit = () =>
  screen.findByRole("spinbutton", {
    name: /Largest file/,
  }) as Promise<HTMLInputElement>;

function typeLimit(input: HTMLInputElement, value: string) {
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}

test("the limit starts at the default and a blur save confirms with Saved", async () => {
  answer();
  render(<AttachmentSettings />);
  const input = await limit();
  await waitFor(() => expect(input.value).toBe("100"));
  expect(screen.getByText("Default")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Use the default/ })).toBeNull();
  typeLimit(input, "25");
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("set_attachment_upload_limit", {
      bytes: 26214400,
    }),
  );
  expect((await screen.findByText("Saved")).getAttribute("role")).toBe(
    "status",
  );
  expect(
    screen.getByRole("button", { name: "Use the default, 100 MiB" }),
  ).toBeTruthy();
  expect(screen.queryByText("Default")).toBeNull();
});

test("Saved goes away when the limit is edited again", async () => {
  answer();
  render(<AttachmentSettings />);
  const input = await limit();
  await waitFor(() => expect(input.value).toBe("100"));
  typeLimit(input, "25");
  await screen.findByText("Saved");
  fireEvent.change(input, { target: { value: "26" } });
  expect(screen.queryByText("Saved")).toBeNull();
});

test("Use the default saves 100 MiB straight away", async () => {
  answer({ attachment_upload_limit: 26214400 });
  render(<AttachmentSettings />);
  const input = await limit();
  await waitFor(() => expect(input.value).toBe("25"));
  fireEvent.click(
    screen.getByRole("button", { name: "Use the default, 100 MiB" }),
  );
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("set_attachment_upload_limit", {
      bytes: 104857600,
    }),
  );
  expect(input.value).toBe("100");
  expect(await screen.findByText("Saved")).toBeTruthy();
});

test("a limit that is not positive is refused beside the field and nothing is saved", async () => {
  answer();
  render(<AttachmentSettings />);
  const input = await limit();
  await waitFor(() => expect(input.value).toBe("100"));
  typeLimit(input, "0");
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe("Enter a size above 0 MiB.");
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(invoke).not.toHaveBeenCalledWith(
    "set_attachment_upload_limit",
    expect.anything(),
  );
  expect(screen.queryByText("Saved")).toBeNull();
});

test("a failed save keeps what was typed and shows the reason without Saved", async () => {
  answer({ set_attachment_upload_limit: new Error("Workspace is read-only") });
  render(<AttachmentSettings />);
  const input = await limit();
  await waitFor(() => expect(input.value).toBe("100"));
  typeLimit(input, "30");
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Couldn't save the upload limit",
  );
  expect(screen.getByRole("alert").textContent).toContain(
    "Workspace is read-only",
  );
  expect(input.value).toBe("30");
  expect(screen.queryByText("Saved")).toBeNull();
});

test("the local tile lists what local storage gives", async () => {
  answer();
  render(<AttachmentSettings />);
  const local = await screen.findByRole("radio", { name: /Local workspace/ });
  await waitFor(() => expect(local.getAttribute("data-state")).toBe("checked"));
  expect(local.textContent).toContain(
    "Files are stored beside the workspace on this computer.",
  );
  expect(local.textContent).toContain("Available offline");
  expect(local.textContent).toContain("Included in backups");
});

test("Drive is disabled with a way to set it up when Drive is not configured", async () => {
  answer({
    drive_configuration: { configured: false, message: "Set CLIENT_ID" },
  });
  const openPage = vi.fn();
  render(
    <SettingsStateContext value={{ openPage } as unknown as SettingsState}>
      <AttachmentSettings />
    </SettingsStateContext>,
  );
  const tile = await screen.findByRole("radio", { name: /Google Drive/ });
  await waitFor(() => expect((tile as HTMLButtonElement).disabled).toBe(true));
  expect(tile.textContent).toContain("Connect Google Drive to choose this");
  expect(
    screen.getByRole("button", { name: "Set up Google Drive" }).dataset.slot,
  ).toBe("settings-link");
  fireEvent.click(screen.getByRole("button", { name: "Set up Google Drive" }));
  expect(openPage).toHaveBeenCalledWith("google-drive");
});

test("Drive stays selectable and shows no setup link when it is configured", async () => {
  answer();
  render(<AttachmentSettings />);
  const tile = await screen.findByRole("radio", { name: /Google Drive/ });
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("drive_configuration"),
  );
  expect((tile as HTMLButtonElement).disabled).toBe(false);
  expect(
    screen.queryByRole("button", { name: "Set up Google Drive" }),
  ).toBeNull();
});

test("choosing Drive picks a writable folder, shows the folder row, and a failed change keeps it", async () => {
  answer();
  render(<AttachmentSettings />);
  const local = await screen.findByRole("radio", { name: /Local workspace/ });
  await waitFor(() => expect(local.getAttribute("data-state")).toBe("checked"));
  fireEvent.click(screen.getByRole("radio", { name: /Google Drive/ }));
  await screen.findByText("Team files");
  expect(screen.getByText(/Checked again before each upload/)).toBeTruthy();
  answer({
    set_attachment_upload_destination: new Error(
      "Folder is read-only. Choose a writable folder.",
    ),
    attachment_upload_destination: drive,
  });
  fireEvent.click(screen.getByRole("button", { name: "Change folder…" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Couldn't change the upload destination",
  );
  expect(screen.getByText("Team files")).toBeTruthy();
  expect(
    screen
      .getByRole("radio", { name: /Google Drive/ })
      .getAttribute("data-state"),
  ).toBe("checked");
});

test("an unreadable destination offers Retry and the footnote stays", async () => {
  answer({ attachment_upload_destination: new Error("offline") });
  render(<AttachmentSettings />);
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Couldn't read the upload destination",
  );
  answer();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  const local = await screen.findByRole("radio", { name: /Local workspace/ });
  await waitFor(() => expect(local.getAttribute("data-state")).toBe("checked"));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(
    screen.getByText(/Drive failures never switch storage automatically/),
  ).toBeTruthy();
});
