// @vitest-environment jsdom
import { IDBFactory } from "fake-indexeddb";
import {
  cleanup,
  fireEvent,
  render,
  screen,
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
  await within(pane).findByText("Missing from this computer");
  // Open can't work, and says why instead of failing.
  expect(
    within(pane).getByRole<HTMLButtonElement>("button", { name: "Open file" })
      .disabled,
  ).toBe(true);
  fireEvent.click(
    within(pane).getByRole("button", { name: "Restore from a backup…" }),
  );
  expect(openSettings).toHaveBeenCalledWith("backups-export");
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

test("an upload over the limit says its size and the limit, and offers Remove instead of Retry", async () => {
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "attachment_upload_destination") return { kind: "local" };
    if (command === "begin_attachment_upload")
      return (args as { explicit?: unknown })?.explicit ?? { kind: "local" };
    if (command === "attachment_workspace_id") return "workspace";
    if (command === "attachment_upload_limit") return 104857600;
    throw new Error(`Unexpected ${command}`);
  });
  const openSettings = vi.fn();
  render(
    <SettingsNavigation.Provider value={openSettings}>
      <AttachmentPicker open onOpenChange={vi.fn()} onPick={vi.fn()} />
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
  // The limit is 100 MB and has no setting to change.
  expect(
    within(row).queryByRole("button", { name: "Change limit" }),
  ).toBeNull();
  expect(openSettings).not.toHaveBeenCalled();
});

const stored = (name: string, size: number) => ({
  ...notes,
  display_name: name,
  original_filename: name,
  size_bytes: size,
});
function previewing(answer: object) {
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "attachment_workspace_id" ? "workspace" : answer,
  );
  render(<AttachmentPreview target={{ id: notes.id }} onClose={() => {}} />);
}

test("a format with no preview says its one sentence, with its extension on the tile", async () => {
  previewing(
    preview("unsupported", { attachment: stored("traces.zip", 48_000_000) }),
  );
  expect(await screen.findByText("No preview for ZIP archives")).toBeTruthy();
  expect(
    screen.getByText("Open it in its app to see what’s inside."),
  ).toBeTruthy();
  expect(screen.getByText("ZIP", { selector: "span" })).toBeTruthy();
});

test("a file too large to preview says its size and what to do", async () => {
  previewing(
    preview("too_large", {
      attachment: stored("recording.mov", 1_932_735_283),
    }),
  );
  expect(await screen.findByText("Too large to preview")).toBeTruthy();
  expect(
    screen.getByText("It’s 1.8 GB. Open it in its app to watch it."),
  ).toBeTruthy();
});

test("Open and Export stay disabled for a stored copy that can't be read", async () => {
  previewing(
    preview("unavailable", {
      attachment: stored("scan.pdf", 1200),
      message: "permission denied",
    }),
  );
  expect(await screen.findByText("Couldn’t read this file")).toBeTruthy();
  for (const name of ["Open file", "Export file"])
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name }).disabled,
    ).toBe(true);
});
