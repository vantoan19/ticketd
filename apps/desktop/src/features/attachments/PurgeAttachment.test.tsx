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
  render(<AttachmentLibrary onPreview={() => {}} />);
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Permanently purge Pending trace",
    }),
  );
  const confirm = await screen.findByRole("button", {
    name: "Permanently purge file",
  });
  await waitFor(() => expect(confirm).toHaveProperty("disabled", false));
  fireEvent.click(confirm);
  await screen.findByRole("button", { name: "Retry permanent purge" });
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
  fireEvent.click(
    screen.getByRole("button", { name: "Retry permanent purge" }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(
    await screen.findByText("Permanently purged · Bytes unavailable"),
  ).toBeTruthy();
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
