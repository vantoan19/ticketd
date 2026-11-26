import { revealFailureDetails } from "@/test/failure-details";
// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { AttachmentLibrary } from "./AttachmentLibrary";
import { AttachmentCleanup } from "./AttachmentCleanup";
import { SettingsNavigation } from "@/lib/settings-navigation";

/** Opens a Radix menu the way a pointer does. */
async function openMenu(name: string) {
  const trigger = await screen.findByRole("button", { name });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  await screen.findByRole("menu");
}

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

test("discovery identifies uploaded copies without opening each preview", async () => {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "search_attachments")
      return [
        {
          attachment: {
            id: "uploaded",
            display_name: "Uploaded trace",
            original_filename: "trace.txt",
            size_bytes: 9,
            kind: "external_reference",
            locator: "drive:account:file",
            uploaded_copy: true,
          },
          related: false,
          usage: {
            eligible: false,
            legacy_drafts_pending: false,
            protections: [],
          },
        },
      ];
    throw new Error(`Unexpected ${command}`);
  });
  render(<AttachmentLibrary />);
  await screen.findByRole("button", { name: "Uploaded trace" });
  expect(screen.getByText(/Uploaded copy/)).toBeTruthy();
  expect(screen.queryByText(/External reference/)).toBeNull();
  expect(invoke).not.toHaveBeenCalledWith(
    "attachment_preview",
    expect.anything(),
  );
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
  render(<AttachmentLibrary />);
  await screen.findByRole("button", { name: "Unused trace" });
  await openMenu("More library actions");
  fireEvent.click(
    screen.getByRole("menuitem", { name: "Clean up unused files…" }),
  );
  await screen.findByRole("dialog", { name: "Clean up unused files" });
  await screen.findByRole("checkbox", { name: "Select Unused trace" });
  const protections = screen.getByRole("button", {
    name: /^Protected\s*1$/,
  });
  expect(protections.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(protections);
  expect(screen.getByText("In an unsaved draft")).toBeTruthy();
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
  // The status line says what moved and offers Undo.
  await screen.findByText("Moved Unused trace to quarantine");
  expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
  await screen.findByText("Quarantined");
  await openMenu("More actions for Unused trace");
  fireEvent.click(screen.getByRole("menuitem", { name: "Restore" }));
  await waitFor(() => expect(screen.queryByText("Quarantined")).toBeNull());
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
  await revealFailureDetails();
  expect(screen.getByRole("alert").textContent).toContain(
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
  render(<AttachmentLibrary />);
  await screen.findByRole("button", { name: "Current plan" });
  expect(screen.getByText(/Google Drive/)).toBeTruthy();
  expect(screen.queryByText(/0 B/)).toBeNull();
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
  render(<AttachmentLibrary />);
  fireEvent.click(await screen.findByRole("button", { name: "Trace" }));
  // The file opens in the detail pane beside the list.
  expect(await screen.findByRole("region", { name: "Trace" })).toBeTruthy();
  await openMenu("Filters");
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Unused" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenLastCalledWith("search_attachments", {
      query: expect.objectContaining({ state: "unused", limit: 50 }),
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Search files" }));
  fireEvent.change(screen.getByRole("searchbox", { name: "Search files" }), {
    target: { value: "no match" },
  });
  await screen.findByText("No attachments match “no match”");
  expect(screen.queryByRole("list", { name: "Files" })).toBeNull();
  // The empty state's Clear search, not the search field's own clear button.
  const empty = screen
    .getByText("No attachments match “no match”")
    .closest<HTMLElement>('[data-slot="empty-state"]')!;
  fireEvent.click(within(empty).getByRole("button", { name: "Clear search" }));
  expect(await screen.findByRole("button", { name: "Trace" })).toBeTruthy();
});

test("adding files to the library offers storage without an insertion into nowhere", async () => {
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "search_attachments"
      ? []
      : command === "attachment_workspace_id"
        ? "workspace"
        : 104857600,
  );
  render(<AttachmentLibrary />);
  fireEvent.click(screen.getByRole("button", { name: "Add files" }));
  expect(screen.getByRole("dialog", { name: "Add files" })).toBeTruthy();
  expect(screen.queryByRole("radio", { name: "Existing files" })).toBeNull();
  expect(screen.getByRole("button", { name: "Choose files" })).toBeTruthy();
});

test("the library opens its storage settings from the header menu", async () => {
  vi.mocked(invoke).mockResolvedValue([]);
  const settings = vi.fn();
  render(
    <SettingsNavigation.Provider value={settings}>
      <AttachmentLibrary />
    </SettingsNavigation.Provider>,
  );
  await screen.findByText("No attachments yet");
  await openMenu("More library actions");
  fireEvent.click(screen.getByRole("menuitem", { name: "Storage settings" }));
  expect(settings).toHaveBeenCalledWith("files");
});

test("usage stays compact in the row without labeling recovery as unused", async () => {
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
  render(<AttachmentLibrary />);
  expect(await screen.findByText(/Used in 2/)).toBeTruthy();
  expect(screen.queryByText(/not a direct ticket attachment/)).toBeNull();
  expect(screen.queryByText(/Unused/)).toBeNull();
  expect(screen.getByText(/Kept for recovery/)).toBeTruthy();
});

test("an empty library says so, with no table, paging or Clean up over nothing", async () => {
  vi.mocked(invoke).mockResolvedValue([]);
  render(<AttachmentLibrary />);
  expect(await screen.findByText("No attachments yet")).toBeTruthy();
  expect(screen.queryByText(/No attachments match/)).toBeNull();
  expect(screen.queryByRole("list", { name: "Files" })).toBeNull();
  expect(screen.queryByRole("button", { name: /Show \d+ more/ })).toBeNull();
  expect(screen.queryByRole("button", { name: "Search files" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Filters" })).toBeNull();
  expect(
    screen.queryByRole("button", { name: "More library actions" }),
  ).toBeNull();
  expect(screen.getByRole("button", { name: "Add files" })).toBeTruthy();
});

test("typing a search keeps the rows in place until the new answer arrives", async () => {
  const row = (id: string) => ({
    attachment: {
      id,
      display_name: id,
      original_filename: `${id}.txt`,
      size_bytes: 1,
      kind: "local_snapshot",
      locator: `${id}/bytes/${id}.txt`,
    },
    related: false,
    usage: { eligible: true, legacy_drafts_pending: false, protections: [] },
  });
  let answer: (rows: unknown[]) => void = () => {};
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command !== "search_attachments") return [];
    const { query } = args as { query: { search: string } };
    if (query.search === "") return [row("Trace"), row("Notes")];
    return new Promise((done) => {
      answer = done;
    });
  });
  render(<AttachmentLibrary />);
  await screen.findByRole("button", { name: "Trace" });
  fireEvent.click(screen.getByRole("button", { name: "Search files" }));
  fireEvent.change(screen.getByRole("searchbox", { name: "Search files" }), {
    target: { value: "no" },
  });
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("search_attachments", {
      query: expect.objectContaining({ search: "no" }),
    }),
  );
  // No blank "Loading files…" between keystrokes: the old rows stay.
  expect(screen.queryByText("Loading files…")).toBeNull();
  expect(screen.getByRole("button", { name: "Trace" })).toBeTruthy();
  answer([row("Notes")]);
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Trace" })).toBeNull(),
  );
  expect(screen.getByRole("button", { name: "Notes" })).toBeTruthy();
});
