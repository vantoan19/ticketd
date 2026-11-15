// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { syncReview, type Availability } from "@/lib/sync-review-api";
import { AttachmentLibrary } from "@/features/attachments/AttachmentLibrary";
import { AttachmentPreview } from "@/features/attachments/AttachmentPreview";
import { TicketAttachments } from "@/features/tickets/TicketAttachments";
import type { Ticket } from "@/lib/api/client";
import { WorkspaceChangeProvider } from "@/lib/workspace-change";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@/lib/sync-review-api", () => ({
  syncReview: { availability: vi.fn(), download: vi.fn() },
}));

const file = (id: string, display_name: string) => ({
  id,
  display_name,
  original_filename: display_name,
  size_bytes: 193,
  kind: "local_snapshot" as const,
  locator: `${id}/bytes/${display_name}`,
  added_at: "2026-11-11T10:00:00Z",
});
const files = [
  file("a", "recording.mp4"),
  file("b", "design.pdf"),
  file("c", "report.md"),
];
let states: Availability[];
let mode: "automatic" | "on_open";

beforeEach(() => {
  mode = "automatic";
  states = [
    { id: "a", state: "not_downloaded", progress: null },
    { id: "b", state: "downloading", progress: 40 },
    { id: "c", state: "downloaded", progress: null },
  ];
  vi.mocked(syncReview.availability).mockImplementation(async (ids) =>
    states.filter((item) => ids.includes(item.id)),
  );
  vi.mocked(syncReview.download).mockImplementation(async (id) => {
    states = states.map((item) =>
      item.id === id ? { ...item, state: "downloading", progress: 0 } : item,
    );
  });
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "search_attachments")
      return files.map((attachment) => ({
        attachment,
        related: false,
        usage: {
          eligible: false,
          legacy_drafts_pending: false,
          protections: [],
        },
      }));
    if (command === "ticket_attachments") return files;
    if (command === "attachment_workspace_id") return "workspace";
    if (command === "sync_settings")
      return {
        desktop_name: "Laptop",
        device_code: "KQ",
        poll_interval_secs: 60,
        attachment_download: mode,
      };
    if (command === "attachment_preview")
      return {
        attachment: files[0],
        status: "missing",
        media_type: "video/mp4",
        message: null,
        can_open: false,
        usage: { total: 0, entries: [], legacy_drafts_pending: false },
      };
    throw new Error(`Unexpected ${command}`);
  });
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

test("the library's Storage column says what is on this desktop and offers Download", async () => {
  render(<AttachmentLibrary onPreview={() => {}} />);
  expect(
    await screen.findByRole("cell", { name: "Not downloaded" }),
  ).toBeTruthy();
  expect(
    screen
      .getByRole("progressbar", { name: "Downloading design.pdf" })
      .getAttribute("aria-valuenow"),
  ).toBe("40");
  expect(screen.getByRole("cell", { name: "Local snapshot" })).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Download design.pdf" }),
  ).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Download recording.mp4" }),
  );
  await waitFor(() => expect(syncReview.download).toHaveBeenCalledWith("a"));
  await screen.findByRole("progressbar", { name: "Downloading recording.mp4" });
  expect(screen.queryByRole("cell", { name: "Not downloaded" })).toBeNull();
});

test("a ticket's attached files say whether they are downloaded", async () => {
  render(
    <TicketAttachments
      ticket={{ id: "t", reference: "T-KQ12", trashed: false } as Ticket}
      revision={0}
      refresh={async () => {}}
    />,
  );
  expect(await screen.findByText("193 B · Not downloaded")).toBeTruthy();
  expect(screen.getByText("193 B · Downloading…")).toBeTruthy();
  expect(screen.getByText("193 B · Local snapshot")).toBeTruthy();
});

test("the preview of a file that is not downloaded offers Download in place of the file", async () => {
  render(<AttachmentPreview target={{ id: "a" }} onClose={() => {}} />);
  expect(
    await screen.findByRole("heading", { name: "Not downloaded" }),
  ).toBeTruthy();
  expect(screen.getByText("This file is in your Google Drive.").role).toBe(
    "status",
  );
  expect(screen.getByText("Not downloaded · 193 B")).toBeTruthy();
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Open file" })
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Download" }));
  await waitFor(() => expect(syncReview.download).toHaveBeenCalledWith("a"));
  expect(
    await screen.findByRole("heading", { name: "Downloading…" }),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
});

test("with Attachments downloaded when opened, opening one that is not here downloads it and shows progress", async () => {
  mode = "on_open";
  // The download answers only when the file is here; progress shows meanwhile.
  vi.mocked(syncReview.download).mockReturnValue(new Promise(() => {}));
  render(<AttachmentPreview target={{ id: "a" }} onClose={() => {}} />);
  await waitFor(() => expect(syncReview.download).toHaveBeenCalledWith("a"));
  expect(
    await screen.findByRole("heading", { name: "Downloading…" }),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
  expect(syncReview.download).toHaveBeenCalledTimes(1);
});

test("with automatic downloads, a file that did not arrive waits for Download", async () => {
  render(<AttachmentPreview target={{ id: "a" }} onClose={() => {}} />);
  await screen.findByRole("button", { name: "Download" });
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("sync_settings"));
  expect(syncReview.download).not.toHaveBeenCalled();
});

test("a download on open that fails says why and leaves Download", async () => {
  mode = "on_open";
  vi.mocked(syncReview.download).mockRejectedValue(new Error("offline"));
  render(<AttachmentPreview target={{ id: "a" }} onClose={() => {}} />);
  expect((await screen.findAllByRole("alert"))[0]?.textContent).toContain(
    "Couldn't download the file. Offline.",
  );
  expect(screen.getByRole("button", { name: "Download" })).toBeTruthy();
  expect(syncReview.download).toHaveBeenCalledTimes(1);
});

test("availability that cannot be read again keeps what was last known", async () => {
  const ticket = { id: "t", reference: "T-KQ12", trashed: false } as Ticket;
  const view = (change: number) => (
    <WorkspaceChangeProvider value={change}>
      <TicketAttachments
        ticket={ticket}
        revision={0}
        refresh={async () => {}}
      />
    </WorkspaceChangeProvider>
  );
  const { rerender } = render(view(0));
  await screen.findByText("193 B · Not downloaded");
  vi.mocked(syncReview.availability).mockRejectedValue(new Error("busy"));
  rerender(view(1));
  await waitFor(() => expect(syncReview.availability).toHaveBeenCalledTimes(2));
  await act(() => new Promise<void>((done) => setTimeout(done)));
  expect(screen.getByText("193 B · Not downloaded")).toBeTruthy();
});
