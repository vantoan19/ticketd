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

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

test("quarantine separates restore from confirmed purge and keeps failures actionable", async () => {
  let purged = false;
  let attempts = 0;
  const file = {
    id: "local",
    display_name: "Unused trace",
    original_filename: "trace.txt",
    size_bytes: 9,
    kind: "local_snapshot",
    locator: "local/bytes/trace.txt",
    quarantined: true,
  };
  const usage = {
    eligible: true,
    legacy_drafts_pending: false,
    protections: [],
  };
  vi.mocked(invoke).mockImplementation(async (command) => {
    const attachment = { ...file, purge_state: purged ? "purged" : "retained" };
    if (command === "search_attachments")
      return [{ attachment, related: false, usage }];
    if (command === "attachment_cleanup_review")
      return {
        attachment,
        usage,
        eligible: false,
        purge_eligible: true,
        reason: "Quarantined",
      };
    if (command === "purge_attachment") {
      attempts += 1;
      if (attempts === 1)
        throw new Error("Protected by a newly retained draft. Review usage.");
      purged = true;
      return { ...attachment, purge_state: "purged" };
    }
    throw new Error(`Unexpected ${command}`);
  });
  render(<AttachmentLibrary onPreview={() => {}} />);
  await screen.findByRole("button", { name: "Restore Unused trace" });
  const trigger = screen.getByRole("button", {
    name: "Permanently purge Unused trace",
  });
  trigger.focus();
  fireEvent.click(trigger);
  await screen.findByRole("dialog", { name: "Permanently purge this file?" });
  expect(attempts).toBe(0);
  expect(screen.getByText(/cannot be undone/i)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  expect(attempts).toBe(0);
  fireEvent.click(
    screen.getByRole("button", { name: "Permanently purge Unused trace" }),
  );
  const confirm = await screen.findByRole("button", {
    name: "Permanently purge file",
  });
  await waitFor(() => expect(confirm).toHaveProperty("disabled", false));
  fireEvent.click(confirm);
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    expect.stringContaining("newly retained draft"),
  );
  expect(screen.getByRole("dialog")).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Permanently purge file" }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(
    await screen.findByText("Permanently purged · Bytes unavailable"),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Restore Unused trace" }),
  ).toBeNull();
});
