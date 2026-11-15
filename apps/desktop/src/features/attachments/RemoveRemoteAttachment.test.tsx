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
import { RemoveRemoteAttachment } from "./RemoveRemoteAttachment";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

test("current draft and legacy protections disable record removal", async () => {
  const file = {
    id: "remote",
    display_name: "Runbook",
    original_filename: "Runbook",
    size_bytes: null,
    kind: "external_reference" as const,
    locator: "drive:connection:file",
  };
  vi.mocked(invoke).mockResolvedValue({
    attachment: file,
    eligible: false,
    remove_eligible: false,
    reason: "Protected",
    usage: {
      eligible: false,
      legacy_drafts_pending: true,
      protections: [
        {
          kind: "undo",
          owner: "document-history",
          ticket_id: null,
          trashed: false,
        },
      ],
    },
  });
  render(
    <RemoveRemoteAttachment
      file={file}
      onClose={() => {}}
      onChanged={() => {}}
    />,
  );
  await screen.findByRole("alert");
  expect(
    (
      screen.getByRole("button", {
        name: "Remove from ticketd",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(screen.getByRole("alert").textContent).toContain("Undo");
  expect(vi.mocked(invoke).mock.calls.map(([name]) => name)).toEqual([
    "attachment_cleanup_review",
  ]);
});

test("remote removal is explicit, keeps a Drive link and retries the same request after uncertainty", async () => {
  const file = {
    id: "remote",
    display_name: "Uploaded diagnostic.zip",
    original_filename: "diagnostic.zip",
    size_bytes: 25,
    kind: "external_reference",
    locator: "drive:connection:file",
  };
  const usage = {
    eligible: true,
    legacy_drafts_pending: false,
    protections: [],
  };
  let removed = false;
  const requests: unknown[] = [];
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "search_attachments")
      return removed ? [] : [{ attachment: file, related: false, usage }];
    if (command === "attachment_cleanup_review")
      return {
        attachment: file,
        eligible: false,
        remove_eligible: true,
        reason: "No local storage to reclaim",
        usage,
      };
    if (command === "remove_remote_attachment") {
      requests.push(args);
      if (requests.length === 1) throw new Error("Response lost");
      removed = true;
      return {
        id: file.id,
        display_name: file.display_name,
        open_url: "https://drive.google.com/file/d/file/view",
        message: "The file remains in Drive.",
      };
    }
    throw new Error(`Unexpected ${command}`);
  });
  render(<AttachmentLibrary onPreview={() => {}} />);
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Remove Uploaded diagnostic.zip from ticketd",
    }),
  );
  await screen.findByRole("dialog", { name: "Remove from ticketd?" });
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "Remove from ticketd",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  expect(
    screen.getByText(/including copies uploaded by ticketd/i),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(requests).toHaveLength(0);
  fireEvent.click(
    screen.getByRole("button", {
      name: "Remove Uploaded diagnostic.zip from ticketd",
    }),
  );
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "Remove from ticketd",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Remove from ticketd" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Remove from ticketd" }));
  await screen.findByRole("dialog", { name: "Removed from ticketd" });
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(requests[1]);
  expect(screen.getByRole("button", { name: "Open in Drive" })).toBeTruthy();
  expect(screen.getByText(/choose it again.*Google Drive/i)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: file.display_name }),
    ).toBeNull(),
  );
  // The library is now empty, so Clean up is gone and Add files takes focus.
  await waitFor(() =>
    expect(document.activeElement?.textContent).toBe("Add files"),
  );
});
