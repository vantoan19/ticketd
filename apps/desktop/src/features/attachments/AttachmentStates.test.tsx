// @vitest-environment jsdom
import { IDBFactory } from "fake-indexeddb";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { SettingsNavigation } from "@/lib/settings-navigation";
import { AttachmentLibrary } from "./AttachmentLibrary";
import { AttachmentPicker } from "./AttachmentPicker";
import { AttachmentPreview } from "./AttachmentPreview";
import { formatSize } from "./format-size";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string, protocol: string) =>
    `${protocol}://localhost/${path}`,
  Channel: class {
    onmessage = () => {};
  },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const notes = {
  id: "notes",
  display_name: "notes.txt",
  original_filename: "notes.txt",
  size_bytes: 17,
  kind: "local_snapshot" as const,
  locator: "notes/bytes/notes.txt",
};
const usage = { eligible: true, legacy_drafts_pending: false, protections: [] };
const preview = (status: string, extra: object = {}) => ({
  attachment: notes,
  status,
  media_type: null,
  message: null,
  can_open: status !== "missing",
  usage: { total: 0, entries: [], legacy_drafts_pending: false },
  ...extra,
});

test("sizes read as people say them, without MiB or a trailing .0", () => {
  expect(formatSize(590)).toBe("590 B");
  expect(formatSize(2150)).toBe("2.1 KB");
  expect(formatSize(104857600)).toBe("100 MB");
  expect(formatSize(105906176)).toBe("101 MB");
});

test("a missing file is flagged in the library and its preview offers a real way back", async () => {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "search_attachments")
      return [{ attachment: notes, usage, related: false, missing: true }];
    if (command === "attachment_workspace_id") return "workspace";
    if (command === "attachment_preview") return preview("missing");
    throw new Error(`Unexpected ${command}`);
  });
  const openSettings = vi.fn();
  render(
    <SettingsNavigation.Provider value={openSettings}>
      <AttachmentLibrary />
    </SettingsNavigation.Provider>,
  );
  const row = await screen.findByRole("button", { name: "notes.txt" });
  expect(await within(row).findByText("Missing")).toBeTruthy();
  fireEvent.click(row);
  const pane = await screen.findByRole("region", { name: "notes.txt" });
  await within(pane).findByText("This file is missing from this computer");
  // Open can't work, and says why instead of failing.
  expect(
    within(pane).getByRole<HTMLButtonElement>("button", { name: "Open file" })
      .disabled,
  ).toBe(true);
  fireEvent.click(
    within(pane).getByRole("button", { name: "Restore from a backup…" }),
  );
  expect(openSettings).toHaveBeenCalledWith("backups");
});

test("plain text previews as text, and other formats say so once without Retry", async () => {
  let answer = preview("unsupported", {
    text_excerpt: { text: "Launch checklist\n- Ship", truncated: true },
  });
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "attachment_workspace_id" ? "workspace" : answer,
  );
  const view = render(
    <AttachmentPreview target={{ id: notes.id }} onClose={() => {}} />,
  );
  expect((await screen.findByLabelText("Text of notes.txt")).textContent).toBe(
    "Launch checklist\n- Ship",
  );
  expect(screen.getByText(/Showing the start of the file/)).toBeTruthy();
  view.unmount();
  answer = {
    ...preview("unsupported"),
    attachment: {
      ...notes,
      display_name: "guide.pdf",
      original_filename: "guide.pdf",
    },
  };
  render(<AttachmentPreview target={{ id: notes.id }} onClose={() => {}} />);
  expect(await screen.findByText("No preview for PDF files")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
});

test("an upload over the limit says its size and the limit, and offers Change limit instead of Retry", async () => {
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "attachment_upload_destination") return { kind: "local" };
    if (command === "begin_attachment_upload")
      return (args as { explicit?: unknown })?.explicit ?? { kind: "local" };
    if (command === "attachment_workspace_id") return "workspace";
    if (command === "attachment_upload_limit") return 104857600;
    throw new Error(`Unexpected ${command}`);
  });
  const openSettings = vi.fn();
  const changed = vi.fn();
  render(
    <SettingsNavigation.Provider value={openSettings}>
      <AttachmentPicker open onOpenChange={changed} onPick={vi.fn()} />
    </SettingsNavigation.Provider>,
  );
  const big = new File(["x"], "recording.mov");
  Object.defineProperty(big, "size", { value: 105906176 });
  fireEvent.drop(
    screen.getByText("Drop files here, or choose them from your computer."),
    { dataTransfer: { files: [big], types: ["Files"] } },
  );
  const row = await screen.findByRole("listitem", { name: "recording.mov" });
  expect((await within(row).findByRole("alert")).textContent).toBe(
    "Too large: 101 MB. The limit is 100 MB.",
  );
  expect(within(row).queryByRole("button", { name: "Retry" })).toBeNull();
  expect(within(row).getByRole("button", { name: "Remove" })).toBeTruthy();
  fireEvent.click(within(row).getByRole("button", { name: "Change limit" }));
  expect(openSettings).toHaveBeenCalledWith("attachments");
  await waitFor(() => expect(changed).toHaveBeenCalledWith(false));
});
