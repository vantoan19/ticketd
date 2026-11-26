// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { AttachmentCard } from "./AttachmentCard";
import { driveType } from "./drive-type";
import type { Attachment } from "@/lib/api/attachments";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {},
  convertFileSrc: (value: string) => `http://media.localhost/${value}`,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function stored(name: string, size = 1.2 * 1048576): Attachment {
  return {
    id: name,
    display_name: name,
    original_filename: name,
    size_bytes: size,
    kind: "local_snapshot",
    locator: `${name}/bytes/${name}`,
  };
}
const preview = (file: Attachment, status: string) => ({
  attachment: file,
  status,
  media_type: null,
  message: null,
  can_open: false,
  usage: { total: 0, legacy_drafts_pending: false, entries: [] },
});

test("a file whose stored copy is gone reads Missing with the attention dot", async () => {
  const file = stored("psp-webhook-capture.har");
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "attachment_workspace_id"
      ? "workspace"
      : preview(file, "missing"),
  );
  render(<AttachmentCard file={file} storageKnown onOpen={() => {}} />);
  const card = screen.getByRole("button");
  await waitFor(() => expect(card.textContent).toContain("Missing · 1.2 MB"));
  expect(card.textContent).not.toContain("HAR file");
  expect(card.querySelector('[data-slot="status-dot"]')).not.toBeNull();
});

test("a copy still in the sync storage, or an answer not known yet, is never called missing", async () => {
  const file = stored("psp-webhook-capture.har");
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "attachment_workspace_id"
      ? "workspace"
      : preview(file, "missing"),
  );
  const view = render(<AttachmentCard file={file} onOpen={() => {}} />);
  // Where the files are is not known yet: nothing is asked.
  expect(invoke).not.toHaveBeenCalled();
  view.rerender(
    <AttachmentCard
      file={file}
      storageKnown
      storage={{ id: file.id, state: "not_downloaded", progress: null }}
      onOpen={() => {}}
    />,
  );
  expect(screen.getByRole("button").textContent).toContain("Not downloaded");
  expect(invoke).not.toHaveBeenCalled();
});

test("a file that is here keeps its type word", async () => {
  const file = stored("old.log");
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "attachment_workspace_id"
      ? "workspace"
      : preview(file, "available"),
  );
  render(<AttachmentCard file={file} storageKnown onOpen={() => {}} />);
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      "attachment_preview",
      expect.anything(),
    ),
  );
  expect(screen.getByRole("button").textContent).toContain("Log · 1.2 MB");
});

test("tile glyphs follow the file type: code, table and archive", () => {
  const glyph = (name: string) => {
    const { container } = render(
      <AttachmentCard file={stored(name)} onOpen={() => {}} />,
    );
    const classes = container
      .querySelector(".file-card-tile svg")
      ?.getAttribute("class");
    cleanup();
    return classes;
  };
  expect(glyph("report.html")).toContain("lucide-file-code");
  expect(glyph("capture.har")).toContain("lucide-file-code");
  expect(glyph("refunds.csv")).toContain("lucide-file-spreadsheet");
  expect(glyph("traces.zip")).toContain("lucide-archive");
  expect(glyph("run.log")).toContain("lucide-file-text");
  expect(glyph("sandbox.p12")).toContain("lucide-file");
});

test("a Drive reference names its type from Drive's last-known details", async () => {
  const file: Attachment = {
    ...stored("Escalations · November"),
    kind: "external_reference",
    uploaded_copy: false,
  };
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "drive_reference"
      ? {
          connection_id: "c",
          metadata: {
            id: "d",
            name: "Escalations · November",
            mime_type: "application/vnd.google-apps.spreadsheet",
            size_bytes: null,
            web_url: "https://docs.google.com/spreadsheets/d/d",
            resource_key: null,
          },
        }
      : null,
  );
  render(<AttachmentCard file={file} onOpen={() => {}} />);
  const card = screen.getByRole("button");
  expect(card.textContent).toContain("Google Drive");
  await waitFor(() =>
    expect(card.textContent).toContain("Google Drive · Sheet"),
  );
  expect(card.textContent).toContain("SHEET ↗");
  expect(
    card.querySelector(".file-card-tile svg")?.getAttribute("class"),
  ).toContain("lucide-file-spreadsheet");
});

test("a Drive file of another kind uses its mime type and extension, or says only Google Drive", () => {
  expect(driveType({ name: "plan.pdf", mime_type: "application/pdf" })).toEqual(
    {
      word: "PDF",
      label: "PDF",
      family: "pdf",
    },
  );
  expect(
    driveType({
      name: "Deck",
      mime_type: "application/vnd.google-apps.presentation",
    })?.word,
  ).toBe("Slides");
  expect(
    driveType({ name: "Mystery", mime_type: "application/x-thing" }),
  ).toBeNull();
});
