// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { AttachmentLibrary } from "./AttachmentLibrary";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

/** Opens a row's "…" menu the way a pointer does and picks an item. */
async function choose(row: string, item: string) {
  const trigger = await screen.findByRole("button", {
    name: `More actions for ${row}`,
  });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole("menuitem", { name: item }));
  return trigger;
}
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

test("pending purge keeps technical diagnostics collapsed and retries without claiming completion", async () => {
  let state = "retained";
  const id = "a24f1197-9c1e-414b-b402-84c765d096cf";
  const diagnostic = `attachment: Permanent purge is pending, not confirmed: storage I/O failed. Retry explicit purge for '${id}' after repairing managed storage.`;
  const file = {
    id,
    display_name: "Pending trace",
    original_filename: "trace.txt",
    size_bytes: 9,
    kind: "local_snapshot",
    locator: `${id}/bytes/trace.txt`,
    quarantined: true,
  };
  const usage = {
    eligible: true,
    legacy_drafts_pending: false,
    protections: [],
  };
  vi.mocked(invoke).mockImplementation(async (command) => {
    const attachment = { ...file, purge_state: state };
    if (command === "search_attachments")
      return [{ attachment, usage, related: false }];
    if (command === "attachment_cleanup_review")
      return {
        attachment,
        usage,
        eligible: false,
        purge_eligible: state !== "purged",
        reason: "Quarantined",
      };
    if (command === "purge_attachment") {
      if (state === "retained") {
        state = "pending";
        throw new Error(diagnostic);
      }
      state = "purged";
      return { ...attachment, purge_state: state };
    }
    throw new Error(`Unexpected ${command}`);
  });
  render(<AttachmentLibrary />);
  await choose("Pending trace", "Delete permanently…");
  const confirm = await screen.findByRole("button", {
    name: "Delete permanently",
  });
  await waitFor(() => expect(confirm).toHaveProperty("disabled", false));
  fireEvent.click(confirm);
  await screen.findByRole("button", { name: "Finish deleting" });
  const alert = screen.getByRole("alert");
  expect(alert.textContent).toContain("pending");
  expect(alert.textContent).not.toContain(id);
  expect(alert.textContent).not.toContain("attachment:");
  expect(alert.textContent).not.toContain("repairing managed storage");
  // The raw diagnostic stays under Details until asked for.
  const toggle = within(alert).getByRole("button", { name: "Details" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(alert.textContent).not.toContain(diagnostic);
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(alert.textContent).toContain(diagnostic);
  fireEvent.click(screen.getByRole("button", { name: "Finish deleting" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(await screen.findByText("Deleted")).toBeTruthy();
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
  render(<AttachmentLibrary />);
  await screen.findByText("Quarantined");
  await choose("Unused trace", "Delete permanently…");
  await screen.findByRole("dialog", {
    name: "Delete Unused trace permanently?",
  });
  expect(attempts).toBe(0);
  expect(screen.getByText(/can't be undone/i)).toBeTruthy();
  // Cancel is where focus starts on a destructive confirm.
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Cancel" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(attempts).toBe(0);
  await choose("Unused trace", "Delete permanently…");
  const confirm = await screen.findByRole("button", {
    name: "Delete permanently",
  });
  await waitFor(() => expect(confirm).toHaveProperty("disabled", false));
  fireEvent.click(confirm);
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    expect.stringContaining("newly retained draft"),
  );
  expect(screen.getByRole("dialog")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(await screen.findByText("Deleted")).toBeTruthy();
  expect(
    await screen.findByText("Deleted Unused trace permanently"),
  ).toBeTruthy();
});
