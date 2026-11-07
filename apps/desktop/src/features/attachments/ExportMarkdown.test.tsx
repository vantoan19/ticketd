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
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { ExportMarkdownButton } from "./ExportMarkdown";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

test("mixed export distinguishes verified uploaded copies from changed omissions", async () => {
  vi.mocked(open).mockResolvedValue("C:/sharing");
  vi.mocked(invoke).mockResolvedValue({
    format_version: 1,
    status: "partial",
    directory: "C:/sharing/export",
    markdown_path: "content.md",
    manifest_path: "manifest.json",
    attachments: [
      {
        uri: "ticketd://attachment/workspace/copy",
        attachment_id: "copy",
        kind: "uploaded_copy",
        display_name: "Original.log",
        original_filename: "trace.log",
        path: "files/copy-trace.log",
        external_url: null,
        omission: null,
        copy_status: "unchanged",
      },
      {
        uri: "ticketd://attachment/workspace/changed",
        attachment_id: "changed",
        kind: "uploaded_copy",
        display_name: "Changed.log",
        original_filename: "trace.log",
        path: null,
        external_url: null,
        omission: "Changed bytes were omitted; open in Drive or retry.",
        copy_status: "changed",
      },
    ],
  });
  render(
    <ExportMarkdownButton source={{ kind: "ticket", reference: "T-1" }} />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Export Markdown with files" }),
  );
  await screen.findByRole("dialog", { name: "Export partially complete" });
  expect(
    screen.getByText("Verified uploaded copy · files/copy-trace.log"),
  ).toBeTruthy();
  expect(
    screen.getByText("Changed bytes were omitted; open in Drive or retry."),
  ).toBeTruthy();
});

test("exports selected content and reports partial omissions without changing its source", async () => {
  vi.mocked(open).mockResolvedValue("C:/sharing");
  vi.mocked(invoke).mockResolvedValue({
    format_version: 1,
    status: "partial",
    directory: "C:/sharing/ticketd-export-1",
    markdown_path: "content.md",
    manifest_path: "manifest.json",
    attachments: [
      {
        uri: "ticketd://attachment/workspace/file",
        attachment_id: "file",
        display_name: "missing.log",
        original_filename: "missing.log",
        path: null,
        external_url: null,
        omission: "Restore the missing snapshot and retry.",
      },
    ],
  });
  render(
    <ExportMarkdownButton
      source={{ kind: "markdown", body: "Selected **text**" }}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Export Markdown with files" }),
  );
  expect(
    await screen.findByRole("dialog", {
      name: "Export partially complete",
    }),
  ).toBeTruthy();
  expect(screen.getByText("missing.log")).toBeTruthy();
  expect(
    screen.getByText("Restore the missing snapshot and retry."),
  ).toBeTruthy();
  expect(invoke).toHaveBeenCalledWith("export_markdown_with_files", {
    source: { kind: "markdown", body: "Selected **text**" },
    output: "C:/sharing",
  });
  expect(screen.getByRole("button", { name: "Show manifest" })).toBeTruthy();
});

test("cancelling the output folder does not export anything", async () => {
  vi.mocked(open).mockResolvedValue(null);
  render(
    <ExportMarkdownButton source={{ kind: "ticket", reference: "T-1" }} />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Export Markdown with files" }),
  );
  await waitFor(() => expect(open).toHaveBeenCalled());
  expect(invoke).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("complete external-link exports explain remote bytes and recipient access", async () => {
  vi.mocked(open).mockResolvedValue("C:/sharing");
  vi.mocked(invoke).mockResolvedValue({
    format_version: 1,
    status: "complete",
    directory: "C:/sharing/export",
    markdown_path: "content.md",
    manifest_path: "manifest.json",
    attachments: [
      {
        uri: "ticketd://attachment/workspace/doc",
        attachment_id: "doc",
        kind: "external_reference",
        display_name: "Current plan",
        original_filename: "Current plan",
        path: null,
        external_url: "https://docs.google.com/document/d/doc/edit",
        omission: null,
      },
    ],
  });
  render(
    <ExportMarkdownButton source={{ kind: "ticket", reference: "T-1" }} />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Export Markdown with files" }),
  );
  const result = await screen.findByRole("dialog", { name: "Export complete" });
  expect(
    within(result).getByText(/Recipients need access in Google Drive/)
      .textContent,
  ).toContain("does not include their bytes");
  expect(within(result).getByText("Current plan")).toBeTruthy();
});

test("file-manager failures are announced inside the export result", async () => {
  vi.mocked(open).mockResolvedValue("C:/sharing");
  vi.mocked(invoke).mockResolvedValue({
    format_version: 1,
    status: "complete",
    directory: "C:/sharing/export",
    markdown_path: "content.md",
    manifest_path: "manifest.json",
    attachments: [],
  });
  vi.mocked(revealItemInDir).mockRejectedValue(
    new Error("File manager unavailable"),
  );
  render(
    <ExportMarkdownButton source={{ kind: "markdown", body: "Read me" }} />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Export Markdown with files" }),
  );
  const result = await screen.findByRole("dialog", { name: "Export complete" });
  fireEvent.click(
    within(result).getByRole("button", { name: "Show manifest" }),
  );
  expect((await within(result).findByRole("alert")).textContent).toContain(
    "File manager unavailable",
  );
});

test("closing the result returns keyboard focus after the native folder dialog takes it", async () => {
  vi.mocked(open).mockImplementation(async () => {
    (document.activeElement as HTMLElement | null)?.blur();
    return "C:/sharing";
  });
  vi.mocked(invoke).mockResolvedValue({
    format_version: 1,
    status: "complete",
    directory: "C:/sharing/export",
    markdown_path: "content.md",
    manifest_path: "manifest.json",
    attachments: [],
  });
  render(
    <ExportMarkdownButton source={{ kind: "markdown", body: "Read me" }} />,
  );
  const trigger = screen.getByRole("button", {
    name: "Export Markdown with files",
  });
  trigger.focus();
  fireEvent.click(trigger);
  const result = await screen.findByRole("dialog", { name: "Export complete" });
  fireEvent.click(within(result).getByRole("button", { name: "Done" }));
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});
