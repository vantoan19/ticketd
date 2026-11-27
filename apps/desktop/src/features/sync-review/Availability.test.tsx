import { revealFailureDetails } from "@/test/failure-details";
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
import { TicketFiles } from "@/features/tickets/TicketFiles";
import type { Ticket } from "@/lib/api/client";
import { TestOpenTicket } from "@/features/tickets/open-ticket/testing";
import { fakeChangeSignal } from "@/lib/workspace-reads/fake-signal";
import { SyncStatusContext } from "@/features/sync/sync-status";
import { syncStatus } from "@/features/sync/sync-fixtures";

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
afterEach(async () => {
  cleanup();
  // A read batched in the test's last turn is sent one microtask later: let it
  // answer before the mocks are reset, or it reads an unmocked call.
  await Promise.resolve();
  vi.resetAllMocks();
});

test("the library's rows say what is on this desktop and offer Download", async () => {
  render(<AttachmentLibrary />);
  expect(await screen.findByText(/Not downloaded/)).toBeTruthy();
  expect(
    screen
      .getByRole("progressbar", { name: "Downloading design.pdf" })
      .getAttribute("aria-valuenow"),
  ).toBe("40");
  // A file on this computer needs no storage word in its row.
  expect(screen.queryByText(/On this computer/)).toBeNull();
  fireEvent.pointerDown(
    screen.getByRole("button", { name: "More actions for design.pdf" }),
    { button: 0, ctrlKey: false },
  );
  await screen.findByRole("menu");
  expect(screen.queryByRole("menuitem", { name: "Download" })).toBeNull();
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  fireEvent.pointerDown(
    screen.getByRole("button", { name: "More actions for recording.mp4" }),
    { button: 0, ctrlKey: false },
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: "Download" }));
  await waitFor(() => expect(syncReview.download).toHaveBeenCalledWith("a"));
  await screen.findByRole("progressbar", { name: "Downloading recording.mp4" });
  expect(screen.queryByText(/Not downloaded/)).toBeNull();
});

test("a ticket's attached files say whether they are downloaded", async () => {
  render(
    <TestOpenTicket
      ticket={{ id: "t", reference: "T-KQ12", trashed: false } as Ticket}
    >
      <TicketFiles />
    </TestOpenTicket>,
  );
  expect(await screen.findByText("Not downloaded · 193 B")).toBeTruthy();
  expect(screen.getByText("Downloading… · 193 B")).toBeTruthy();
  expect(screen.getByText("Markdown · 193 B")).toBeTruthy();
});

test("the preview of a file that is not downloaded offers Download in place of the file", async () => {
  render(<AttachmentPreview target={{ id: "a" }} onClose={() => {}} />);
  expect(await screen.findByText("Not downloaded")).toBeTruthy();
  expect(
    screen
      .getByText("It’s in Google Drive. Download it to preview it here.")
      .closest('[role="status"]'),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Download · 193 B" })).toBeTruthy();
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Open file" })
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: /^Download/ }));
  await waitFor(() => expect(syncReview.download).toHaveBeenCalledWith("a"));
  expect((await screen.findAllByText("Downloading…")).length).toBeGreaterThan(
    0,
  );
  expect(screen.queryByRole("button", { name: /^Download/ })).toBeNull();
});

test("the preview of a file waiting in S3 names S3, not Google Drive", async () => {
  render(
    <SyncStatusContext
      value={{
        status: syncStatus({ provider: "s3" }),
        apply: () => {},
        refresh: () => Promise.reject(new Error("unused")),
        openSettings: () => {},
        openReview: () => {},
      }}
    >
      <AttachmentPreview target={{ id: "a" }} onClose={() => {}} />
    </SyncStatusContext>,
  );
  expect(
    await screen.findByText(
      "It’s in your S3 bucket. Download it to preview it here.",
    ),
  ).toBeTruthy();
  expect(screen.queryByText(/Google Drive/)).toBeNull();
});

test("with Attachments downloaded when opened, opening one that is not here downloads it and shows progress", async () => {
  mode = "on_open";
  // The download answers only when the file is here; progress shows meanwhile.
  vi.mocked(syncReview.download).mockReturnValue(new Promise(() => {}));
  render(<AttachmentPreview target={{ id: "a" }} onClose={() => {}} />);
  await waitFor(() => expect(syncReview.download).toHaveBeenCalledWith("a"));
  expect((await screen.findAllByText("Downloading…")).length).toBeGreaterThan(
    0,
  );
  expect(screen.queryByRole("button", { name: /^Download/ })).toBeNull();
  expect(syncReview.download).toHaveBeenCalledTimes(1);
});

test("with automatic downloads, a file that did not arrive waits for Download", async () => {
  render(<AttachmentPreview target={{ id: "a" }} onClose={() => {}} />);
  await screen.findByRole("button", { name: /^Download/ });
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("sync_settings"));
  expect(syncReview.download).not.toHaveBeenCalled();
});

test("a download on open that fails says why and leaves Download", async () => {
  mode = "on_open";
  vi.mocked(syncReview.download).mockRejectedValue(new Error("offline"));
  render(<AttachmentPreview target={{ id: "a" }} onClose={() => {}} />);
  await revealFailureDetails();
  expect(screen.getByText("offline")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  expect(syncReview.download).toHaveBeenCalledTimes(1);
});

test("availability that cannot be read again keeps what was last known", async () => {
  const ticket = { id: "t", reference: "T-KQ12", trashed: false } as Ticket;
  // Nothing is downloading, so only a change can make availability be read again.
  states = [
    { id: "a", state: "not_downloaded", progress: null },
    { id: "b", state: "not_downloaded", progress: null },
    { id: "c", state: "downloaded", progress: null },
  ];
  const signal = fakeChangeSignal();
  render(
    <TestOpenTicket ticket={ticket} signal={signal}>
      <TicketFiles />
    </TestOpenTicket>,
  );
  await screen.findAllByText("Not downloaded · 193 B");
  expect(syncReview.availability).toHaveBeenCalledTimes(1);

  vi.mocked(syncReview.availability).mockRejectedValue(new Error("busy"));
  act(() => signal.change());
  // Well inside the two-second download poll: the change itself re-read it.
  await waitFor(
    () => expect(syncReview.availability).toHaveBeenCalledTimes(2),
    {
      timeout: 1000,
    },
  );
  await act(async () => {});
  expect(screen.getAllByText("Not downloaded · 193 B")).toHaveLength(2);
});

const withSync = (status: ReturnType<typeof syncStatus>, apply = () => {}) => (
  <SyncStatusContext
    value={{
      status,
      apply,
      refresh: () => Promise.reject(new Error("unused")),
      openSettings: () => {},
      openReview: () => {},
    }}
  >
    <AttachmentPreview target={{ id: "a" }} onClose={() => {}} />
  </SyncStatusContext>
);

test("a download the runs gave up on shows Couldn’t download with Retry and Details", async () => {
  states = [
    {
      id: "a",
      state: "not_downloaded",
      progress: null,
      failure: "the storage did not answer",
    },
  ];
  render(<AttachmentPreview target={{ id: "a" }} onClose={() => {}} />);
  expect(await screen.findByText("Couldn’t download")).toBeTruthy();
  expect(
    screen.getByText(
      "Google Drive didn’t answer. Nothing changed on this computer.",
    ),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^Download/ })).toBeNull();
  // Open and Export wait for the bytes, so they stay in place, disabled.
  for (const name of ["Open file", "Export file"])
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name }).disabled,
    ).toBe(true);
  await revealFailureDetails();
  expect(screen.getByText("the storage did not answer")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(syncReview.download).toHaveBeenCalledWith("a"));
});

test("a file whose storage needs sign-in offers Sign in through the sync recovery", async () => {
  const apply = vi.fn();
  const signedIn = syncStatus();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "sync_recover") return signedIn;
    if (command === "attachment_workspace_id") return "workspace";
    if (command === "sync_settings")
      return {
        desktop_name: "Laptop",
        device_code: "KQ",
        poll_interval_secs: 60,
        attachment_download: mode,
      };
    return {
      attachment: files[0],
      status: "missing",
      media_type: "video/mp4",
      message: null,
      can_open: false,
      usage: { total: 0, entries: [], legacy_drafts_pending: false },
    };
  });
  render(withSync(syncStatus({ recovery: "authorization_expired" }), apply));
  expect(await screen.findByText("Needs sign-in")).toBeTruthy();
  expect(
    screen.getByText("Sign in to Google to download this file."),
  ).toBeTruthy();
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Open file" })
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await waitFor(() => expect(apply).toHaveBeenCalledWith(signedIn));
});

test("a download in progress reads as one measure and never as fractions of a byte", async () => {
  states = [{ id: "a", state: "downloading", progress: 18 }];
  render(<AttachmentPreview target={{ id: "a" }} onClose={() => {}} />);
  // 18% of 193 B is 34.74 bytes.
  expect(await screen.findByText("35 of 193 B")).toBeTruthy();
  expect(screen.getByText("Downloading…", { selector: "h3" })).toBeTruthy();
  expect(screen.queryByText(/\.\d+ B/)).toBeNull();
});
