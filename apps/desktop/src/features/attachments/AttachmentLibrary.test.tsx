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
import { AttachmentLibrary } from "./AttachmentLibrary";
import { AttachmentCleanup } from "./AttachmentCleanup";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

test("explicit local cleanup reviews protections and restores quarantine", async () => {
  let quarantined = false;
  const file = {
    id: "stable",
    display_name: "Unused trace",
    original_filename: "trace.txt",
    size_bytes: 9,
    kind: "local_snapshot",
    locator: "stable/bytes/trace.txt",
    added_at: "2026-11-04T10:00:00Z",
  };
  vi.mocked(invoke).mockImplementation(async (command) => {
    const attachment = { ...file, quarantined };
    if (command === "search_attachments")
      return [
        {
          attachment,
          related: false,
          usage: {
            eligible: true,
            legacy_drafts_pending: false,
            protections: [],
          },
        },
      ];
    if (command === "attachment_cleanup_reviews")
      return [
        {
          attachment,
          eligible: true,
          reason: "Unused local snapshot",
          usage: {
            eligible: true,
            legacy_drafts_pending: false,
            protections: [],
          },
        },
        {
          attachment: { ...file, id: "protected", display_name: "Draft trace" },
          eligible: false,
          reason: "Protected by recoverable draft",
          usage: {
            eligible: false,
            legacy_drafts_pending: false,
            protections: [
              {
                kind: "draft",
                owner: "draft",
                ticket_id: null,
                trashed: false,
              },
            ],
          },
        },
      ].reverse();
    if (command === "quarantine_attachment") {
      quarantined = true;
      return { ...file, quarantined };
    }
    if (command === "restore_attachment") {
      quarantined = false;
      return { ...file, quarantined };
    }
    throw new Error(`Unexpected ${command}`);
  });
  render(<AttachmentLibrary onPreview={() => {}} />);
  await screen.findByRole("button", { name: "Unused trace" });
  expect(screen.getByRole("columnheader", { name: "Added" })).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Clean up" }),
  );
  await screen.findByRole("dialog", { name: "Review unused attachments" });
  await screen.findByRole("checkbox", { name: "Select Unused trace" });
  const protections = screen.getByText("Protected or unavailable (1)");
  expect(protections.closest("details")).toHaveProperty("open", false);
  fireEvent.click(protections);
  expect(screen.getByText("Protected · Recoverable draft")).toBeTruthy();
  expect(screen.queryByText("Protected by recoverable draft")).toBeNull();
  expect(
    screen.getByRole("checkbox", { name: "Select Draft trace" }),
  ).toHaveProperty("disabled", true);
  expect(
    screen
      .getByRole("checkbox", { name: "Select Unused trace" })
      .compareDocumentPosition(
        screen.getByRole("checkbox", { name: "Select Draft trace" }),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Select Unused trace" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Move to quarantine" }));
  await screen.findByRole("button", { name: "Restore Unused trace" });
  fireEvent.click(screen.getByRole("button", { name: "Restore Unused trace" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Restore Unused trace" }),
    ).toBeNull(),
  );
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(([command]) => String(command).includes("delete")),
  ).toBe(false);
});

test("a rejected cleanup keeps its review and original request identity for explicit retry", async () => {
  const file = {
    id: "retry",
    display_name: "Trace",
    original_filename: "trace.txt",
    size_bytes: 3,
    kind: "local_snapshot",
    locator: "retry/bytes/trace.txt",
  };
  const close = vi.fn();
  let fail = true;
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "attachment_cleanup_reviews")
      return [
        {
          attachment: file,
          eligible: true,
          reason: "Unused",
          usage: {
            eligible: true,
            legacy_drafts_pending: false,
            protections: [],
          },
        },
      ];
    if (command === "quarantine_attachment") {
      if (fail) throw new Error("A new draft protects this file");
      return { ...file, quarantined: true };
    }
    throw new Error(`Unexpected ${command}`);
  });
  render(<AttachmentCleanup onClose={close} onChanged={() => {}} />);
  fireEvent.click(
    await screen.findByRole("checkbox", { name: "Select Trace" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Move to quarantine" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "A new draft protects this file",
  );
  expect(close).not.toHaveBeenCalled();
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Move to quarantine" }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  const requests = vi
    .mocked(invoke)
    .mock.calls.filter(([command]) => command === "quarantine_attachment");
  expect(requests[0]?.[1]).toEqual(requests[1]?.[1]);
});

test("external references with unknown size stay external and are not fetched for thumbnails", async () => {
  vi.mocked(invoke).mockResolvedValue([
    {
      attachment: {
        id: "native-doc",
        display_name: "Current plan",
        original_filename: "Current plan",
        size_bytes: null,
        kind: "external_reference",
        locator: "drive:connection:native-doc",
      },
      related: false,
      usage: { eligible: true, legacy_drafts_pending: false, protections: [] },
    },
  ]);
  render(<AttachmentLibrary onPreview={() => {}} />);
  await screen.findByRole("button", { name: "Current plan" });
  expect(screen.getByText("External reference")).toBeTruthy();
  expect(screen.getByText("—")).toBeTruthy();
  expect(screen.queryByText("0 B")).toBeNull();
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "search_attachments",
  ]);
});

test("library searches core metadata and state and opens the chosen stable file", async () => {
  const file = {
    id: "stable",
    display_name: "Trace",
    original_filename: "trace.log",
    size_bytes: 9,
    kind: "local_snapshot",
    locator: "stable/bytes/trace.log",
  };
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "search_attachments") {
      const { query } = args as { query: { search: string; state: string } };
      return query.search === "no match"
        ? []
        : [
            {
              attachment: file,
              related: false,
              usage: {
                eligible: true,
                legacy_drafts_pending: false,
                protections: [],
              },
            },
          ];
    }
    throw new Error(`Unexpected ${command}`);
  });
  const preview = vi.fn();
  render(<AttachmentLibrary onPreview={preview} />);
  fireEvent.click(await screen.findByRole("button", { name: "Trace" }));
  expect(preview).toHaveBeenCalledWith(file);
  fireEvent.click(screen.getByRole("radio", { name: "Unused" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenLastCalledWith("search_attachments", {
      query: expect.objectContaining({ state: "unused", limit: 50 }),
    }),
  );
  fireEvent.change(screen.getByRole("searchbox", { name: "Search files" }), {
    target: { value: "no match" },
  });
  await screen.findByText("No matching files");
});

test("adding files to the library offers storage without an insertion into nowhere", async () => {
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "search_attachments"
      ? []
      : command === "attachment_workspace_id"
        ? "workspace"
        : 104857600,
  );
  render(<AttachmentLibrary onPreview={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Add files" }));
  expect(screen.getByRole("dialog", { name: "Add files" })).toBeTruthy();
  expect(screen.queryByRole("radio", { name: "Existing files" })).toBeNull();
  expect(screen.getByRole("button", { name: "Choose files" })).toBeTruthy();
});

test("the library offers the existing storage settings without losing its search surface", async () => {
  vi.mocked(invoke).mockResolvedValue([]);
  const settings = vi.fn();
  render(<AttachmentLibrary onPreview={() => {}} onOpenSettings={settings} />);
  fireEvent.click(screen.getByRole("button", { name: "Storage settings" }));
  expect(settings).toHaveBeenCalledOnce();
  expect(screen.getByRole("searchbox", { name: "Search files" })).toBeTruthy();
});

test("usage stays compact in the table and opens details without labeling recovery as unused", async () => {
  const file = {
    id: "protected",
    display_name: "Trace",
    original_filename: "trace.log",
    size_bytes: 9,
    kind: "local_snapshot",
    locator: "protected/bytes/trace.log",
  };
  vi.mocked(invoke).mockResolvedValue([
    {
      attachment: file,
      related: false,
      usage: {
        eligible: false,
        legacy_drafts_pending: false,
        protections: [
          {
            kind: "document_body",
            owner: "document",
            ticket_id: null,
            trashed: false,
          },
          {
            kind: "ticket_attachment",
            owner: "ticket",
            ticket_id: "ticket",
            trashed: false,
          },
        ],
      },
    },
    {
      attachment: { ...file, id: "pending", display_name: "Recovery file" },
      related: false,
      usage: { eligible: false, legacy_drafts_pending: true, protections: [] },
    },
  ]);
  const preview = vi.fn();
  render(<AttachmentLibrary onPreview={preview} />);
  fireEvent.click(await screen.findByRole("button", { name: "2 places" }));
  expect(preview).toHaveBeenCalledWith(file);
  expect(screen.queryByText(/not a direct ticket attachment/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Unused" })).toBeNull();
  expect(
    screen.getByRole("button", { name: "Recovery protected" }),
  ).toBeTruthy();
});
