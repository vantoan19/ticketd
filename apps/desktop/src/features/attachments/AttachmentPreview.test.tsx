import { StrictMode, useState } from "react";
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
import { AttachmentPreview } from "./AttachmentPreview";
import type { Attachment } from "@/lib/api/attachments";
import { DocumentNavigation } from "@/features/documents/navigation";
import { TicketNavigation } from "@/features/tickets/navigation";
import { setPreference } from "@/lib/preferences";
import reportSource from "@/test/fixtures/attachment-report.html?raw";
import { fakePdf } from "@/test/fake-pdf";
import { openPdf, PdfUnreadable } from "./pdf-document";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string, protocol: string) =>
    `${protocol}://localhost/${path}`,
}));
vi.mock("./pdf-document", () => ({
  openPdf: vi.fn(),
  PdfUnreadable: class PdfUnreadable extends Error {},
}));
beforeEach(() => {
  // These tests read the facts; the viewer keeps them behind "…" until asked.
  setPreference("attachmentDetails", true);
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

test("purged Undo references retain their name with unavailable bytes and deliberate recovery", async () => {
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "attachment_workspace_id"
      ? "workspace"
      : {
          attachment: { ...file, quarantined: true, purge_state: "purged" },
          status: "unavailable",
          media_type: null,
          can_open: false,
          message:
            "Local bytes were permanently purged. Restore an older complete backup to a separate workspace, or choose a replacement for this reference.",
          usage: {
            total: 1,
            entries: [
              {
                kind: "undo",
                owner: "recovered",
                label: "Recoverable Undo",
                trashed: false,
              },
            ],
            legacy_drafts_pending: false,
          },
        },
  );
  render(<AttachmentPreview target={{ id: file.id }} onClose={() => {}} />);
  expect(await screen.findByText("Deleted permanently")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Screenshot" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Restore file" })).toBeNull();
  expect(screen.getByRole("button", { name: "Export file" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(screen.getByText(/older backup/)).toBeTruthy();
  expect(
    screen.queryByText("Quarantined · Restore this file to reuse it."),
  ).toBeNull();
});

test("closing pending inspection ignores its late response and media close releases playback", async () => {
  let complete: ((value: unknown) => void) | undefined;
  const pending = new Promise((resolve) => {
    complete = resolve;
  });
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "attachment_workspace_id" ? "workspace" : pending,
  );
  const view = render(
    <AttachmentPreview
      target={{ id: file.id, initial: file }}
      onClose={() => {}}
    />,
  );
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("attachment_preview", {
      workspace: "workspace",
      id: file.id,
    }),
  );
  view.unmount();
  await act(async () =>
    complete?.({
      attachment: file,
      status: "available",
      media_type: "video/mp4",
      message: null,
      can_open: true,
      usage: { total: 0, entries: [], legacy_drafts_pending: false },
    }),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  const pause = vi
    .spyOn(HTMLMediaElement.prototype, "pause")
    .mockImplementation(() => {});
  const load = vi
    .spyOn(HTMLMediaElement.prototype, "load")
    .mockImplementation(() => {});
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "attachment_workspace_id"
      ? "workspace"
      : {
          attachment: file,
          status: "available",
          media_type: "video/mp4",
          message: null,
          can_open: true,
          usage: { total: 0, entries: [], legacy_drafts_pending: false },
        },
  );
  const playing = render(
    <AttachmentPreview target={{ id: file.id }} onClose={() => {}} />,
  );
  const video = await screen.findByLabelText("Screenshot", {
    selector: "video",
  });
  expect(video.getAttribute("autoplay")).toBeNull();
  expect(video.getAttribute("preload")).toBe("metadata");
  playing.unmount();
  expect(video.hasAttribute("src")).toBe(false);
  expect(pause).toHaveBeenCalledOnce();
  expect(load).toHaveBeenCalledOnce();
});

const file = {
  id: "file-1",
  display_name: "Screenshot",
  original_filename: "screen.png",
  size_bytes: 32,
  kind: "local_snapshot" as const,
  locator: "file-1/bytes/screen.png",
};

test("preview exposes Added, same-identity rename and a reusable workspace link", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  let current = { ...file, added_at: "2026-11-04T10:00:00Z" };
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "attachment_workspace_id") return "workspace";
    if (command === "rename_attachment") {
      current = { ...current, display_name: "Renamed screenshot" };
      return current;
    }
    if (command === "attachment_preview")
      return {
        attachment: current,
        status: "unsupported",
        media_type: null,
        message: "No media preview",
        can_open: true,
        usage: { total: 0, entries: [], legacy_drafts_pending: false },
      };
    throw new Error(`Unexpected ${command}`);
  });
  try {
    render(<AttachmentPreview target={{ id: file.id }} onClose={() => {}} />);
    await screen.findByRole("heading", { name: "Screenshot" });
    expect(
      screen.getByText("Added").nextElementSibling?.querySelector("time")
        ?.dateTime,
    ).toBe("2026-11-04T10:00:00Z");
    // Copy link lives under "…" in the viewer.
    expect(screen.queryByRole("button", { name: "Copy link" })).toBeNull();
    const more = screen.getByRole("button", { name: "More actions" });
    fireEvent.pointerDown(more, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy link" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        "<ticketd://attachment/workspace/file-1>",
      ),
    );
    fireEvent.pointerDown(more, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename…" }));
    const name = await screen.findByRole("textbox", { name: "Display name" });
    fireEvent.change(name, { target: { value: "Renamed screenshot" } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await screen.findByRole("heading", { name: "Renamed screenshot" });
    expect(invoke).toHaveBeenCalledWith(
      "rename_attachment",
      expect.objectContaining({ id: file.id }),
    );
    expect(current.original_filename).toBe("screen.png");
  } finally {
    if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
});

test.each(["ticket", "document"])(
  "saved %s usage navigates and closes the preview",
  async (kind) => {
    const close = vi.fn();
    const openTicket = vi.fn();
    const openDocument = vi.fn();
    vi.mocked(invoke).mockImplementation(async (command) =>
      command === "attachment_workspace_id"
        ? "workspace"
        : {
            attachment: file,
            status: "unsupported",
            media_type: null,
            message: null,
            can_open: true,
            usage: {
              total: 1,
              legacy_drafts_pending: false,
              entries: [
                {
                  kind: kind === "ticket" ? "ticket_body" : "document_body",
                  owner: "owner-id",
                  label: "Saved context",
                  trashed: false,
                  target: {
                    kind,
                    id: kind === "ticket" ? "T-KQ7" : "document-id",
                  },
                },
              ],
            },
          },
    );
    render(
      <TicketNavigation.Provider value={openTicket}>
        <DocumentNavigation.Provider value={openDocument}>
          <AttachmentPreview target={{ id: file.id }} onClose={close} />
        </DocumentNavigation.Provider>
      </TicketNavigation.Provider>,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Saved context" }),
    );
    expect(kind === "ticket" ? openTicket : openDocument).toHaveBeenCalledWith(
      kind === "ticket" ? "T-KQ7" : "document-id",
    );
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
  },
);

test("uploaded copies show changed and unavailable observations with last-known details and explicit retry/export", async () => {
  let status = "changed";
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "attachment_workspace_id") return "workspace";
    if (command === "attachment_preview")
      return {
        attachment: { ...file, kind: "external_reference" },
        status: "unavailable",
        media_type: null,
        message: "Open in Drive",
        can_open: true,
        usage: { total: 0, entries: [], legacy_drafts_pending: false },
      };
    const metadata = {
      id: "blob",
      name: "screen.png",
      mime_type: "image/png",
      size_bytes: 32,
      web_url: "https://drive.google.com/file/d/blob/view",
      resource_key: null,
    };
    if (command === "drive_configuration")
      return { configured: false, message: "Setup deferred" };
    if (command === "check_drive_reference")
      return {
        reference: { connection_id: "connection", metadata },
        failure: { kind: "offline", message: "Drive is offline; retry." },
      };
    if (command === "drive_reference")
      return { connection_id: "connection", metadata };
    if (command === "drive_uploaded_copy_status")
      return {
        status,
        message:
          status === "changed"
            ? "This copy has changed in Drive since upload."
            : "Drive is offline; retry.",
        last_known: metadata,
        current: null,
        error_kind: status === "unavailable" ? "offline" : null,
      };
    throw new Error(`Unexpected ${command}`);
  });
  render(<AttachmentPreview target={{ id: file.id }} onClose={() => {}} />);
  await screen.findByRole("heading", {
    name: "This copy has changed in Drive",
  });
  expect((await screen.findAllByText(/Uploaded copy/)).length).toBeGreaterThan(
    0,
  );
  expect(screen.getByRole("button", { name: "Open in Drive" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Export" })).toBeTruthy();
  status = "unavailable";
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByRole("heading", { name: "Uploaded copy unavailable" });
  expect(screen.getByText("Screenshot")).toBeTruthy();
  expect(screen.getByText(/Drive is offline/)).toBeTruthy();
});

test("Drive access refresh updates displayed metadata while preserving the authored title and open action", async () => {
  let size = 4;
  const remote = {
    ...file,
    kind: "external_reference",
    display_name: "My authored title",
    size_bytes: size,
  };
  const metadata = () => ({
    connection_id: "opaque-account",
    metadata: {
      id: "remote-file",
      name: "Current source name",
      mime_type: "text/plain",
      size_bytes: size,
      web_url: "https://drive.google.com/file/d/remote-file/view",
      resource_key: null,
    },
  });
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "attachment_workspace_id") return "workspace";
    if (command === "attachment_preview")
      return {
        attachment: { ...remote, size_bytes: size },
        status: "unsupported",
        media_type: null,
        message: "No local snapshot",
        can_open: true,
        usage: { total: 0, entries: [], legacy_drafts_pending: false },
      };
    if (command === "drive_reference") return metadata();
    if (command === "drive_uploaded_copy_status") return null;
    if (command === "drive_configuration")
      return { configured: true, message: "Ready" };
    if (command === "check_drive_reference") {
      size = 8;
      return { reference: metadata(), failure: null };
    }
    if (command === "open_attachment") return;
    throw new Error(`Unexpected command ${command}`);
  });
  render(<AttachmentPreview target={{ id: remote.id }} onClose={() => {}} />);
  await screen.findByText("Current source in Google Drive");
  await screen.findByText("Google Drive · External reference");
  await screen.findByText("8 B");
  expect(
    screen.getByRole("heading", { name: "My authored title" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open in Drive" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("open_attachment", { id: remote.id }),
  );
});

test("quarantined content offers explicit same-identity restore without replacing a reference", async () => {
  let quarantined = true;
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "attachment_workspace_id") return "workspace";
    if (command === "restore_attachment") {
      quarantined = false;
      return { ...file, quarantined };
    }
    if (command === "attachment_preview")
      return {
        attachment: { ...file, quarantined },
        status: "unsupported",
        media_type: null,
        message: "No media preview",
        can_open: true,
        usage: { total: 0, entries: [], legacy_drafts_pending: false },
      };
    throw new Error(`Unexpected ${command}`);
  });
  render(<AttachmentPreview target={{ id: file.id }} onClose={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "Restore file" }));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Restore file" })).toBeNull(),
  );
  expect(screen.getByRole("dialog", { name: "Screenshot" })).toBeTruthy();
});

test("usage distinguishes persisted context, recoverable trash and Undo alongside missing metadata", async () => {
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "attachment_workspace_id"
      ? "workspace"
      : {
          attachment: file,
          status: "missing",
          media_type: null,
          message: "Stored bytes are missing",
          can_open: false,
          usage: {
            total: 3,
            legacy_drafts_pending: false,
            entries: [
              {
                kind: "ticket_body",
                owner: "t1",
                label: "T-KQ1 · Checkout failure",
                trashed: false,
              },
              {
                kind: "document_body",
                owner: "d1",
                label: "Incident analysis",
                trashed: true,
              },
              {
                kind: "undo",
                owner: "history",
                label: "Undo history",
                trashed: false,
              },
            ],
          },
        },
  );
  render(
    <AttachmentPreview
      target={{ id: file.id, initial: file }}
      onClose={() => {}}
    />,
  );
  await screen.findByRole("heading", { name: "Used in 3" });
  expect(screen.getByText("T-KQ1 · Checkout failure")).toBeTruthy();
  expect(screen.getByText("Incident analysis")).toBeTruthy();
  expect(screen.getByText(/Document · In Trash/)).toBeTruthy();
  expect(screen.getByText("Undo history")).toBeTruthy();
});

test("a failed image retains metadata and explicit actions, with retry instead of an invented cause", async () => {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "attachment_workspace_id") return "workspace";
    if (command === "attachment_preview")
      return {
        attachment: file,
        status: "available",
        media_type: "image/png",
        message: null,
        can_open: true,
        usage: { total: 0, entries: [], legacy_drafts_pending: false },
      };
    return null;
  });
  render(
    <AttachmentPreview
      target={{ id: file.id, initial: file }}
      onClose={() => {}}
    />,
  );
  const image = await screen.findByRole("img", { name: "Screenshot" });
  expect(image.getAttribute("src")).toBe(
    "attachment-media://localhost/workspace/file-1",
  );
  fireEvent.error(image);
  expect(await screen.findByText("Couldn't show this png image")).toBeTruthy();
  expect(screen.getByText("screen.png")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Export file" })).toBeTruthy();
  expect(invoke).not.toHaveBeenCalledWith("open_attachment", expect.anything());
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByRole("img", { name: "Screenshot" });
  fireEvent.click(screen.getByRole("button", { name: "Open file" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("open_attachment", { id: file.id }),
  );
});

test.each(["image/png", "video/mp4"])(
  "Strict Mode restores %s sources after its effect cleanup rehearsal",
  async (mime) => {
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    vi.mocked(invoke).mockImplementation(async (command) =>
      command === "attachment_workspace_id"
        ? "workspace"
        : {
            attachment: file,
            status: "available",
            media_type: mime,
            message: null,
            can_open: true,
            usage: { total: 0, entries: [], legacy_drafts_pending: false },
          },
    );
    const view = render(
      <StrictMode>
        <AttachmentPreview target={{ id: file.id }} onClose={() => {}} />
      </StrictMode>,
    );
    const element = mime.startsWith("image")
      ? await screen.findByRole("img", { name: "Screenshot" })
      : await screen.findByLabelText("Screenshot", { selector: "video" });
    expect(element.getAttribute("src")).toContain(
      "attachment-media://localhost/workspace/file-1",
    );
    view.unmount();
    expect(element.hasAttribute("src")).toBe(false);
  },
);

test("viewer retains its media and owner until the closing animation completes", async () => {
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "attachment_workspace_id"
      ? "workspace"
      : {
          attachment: file,
          status: "unsupported",
          media_type: null,
          message: null,
          can_open: true,
          usage: { total: 0, entries: [], legacy_drafts_pending: false },
        },
  );
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  const actualStyle = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
    const native = actualStyle(element, pseudo);
    if (!element.hasAttribute("data-slot")) return native;
    return new Proxy(native, {
      get(target, key) {
        if (key === "animationName")
          return element.getAttribute("data-state") === "closed"
            ? "test-exit"
            : "test-enter";
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  });
  try {
    const close = vi.fn();
    render(<AttachmentPreview target={{ id: file.id }} onClose={close} />);
    await screen.findByRole("heading", { name: "Screenshot" });
    const dialog = screen.getByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(close).not.toHaveBeenCalled();
    expect(dialog.isConnected).toBe(true);
    expect(dialog.getAttribute("data-state")).toBe("closed");
    const end = new Event("animationend", { bubbles: true });
    Object.defineProperty(end, "animationName", { value: "test-exit" });
    fireEvent(dialog, end);
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
  } finally {
    vi.unstubAllGlobals();
  }
});

const reportFile = {
  ...file,
  id: "report-1",
  display_name: "E2E report",
  original_filename: "e2e-report.html",
  size_bytes: 4320,
};
const reportPreview = {
  attachment: reportFile,
  status: "unsupported",
  media_type: null,
  message: "Preview unavailable for this format.",
  can_open: true,
  html: true,
  text_excerpt: { text: "<!doctype html>", truncated: true },
  usage: { total: 0, entries: [], legacy_drafts_pending: false },
};
function serveReport(html: () => Promise<string> | string) {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "attachment_workspace_id") return "workspace";
    if (command === "attachment_preview") return reportPreview;
    if (command === "attachment_html") return html();
    return null;
  });
}

test("an HTML report renders read-only in an isolated frame, with scripts and network off", async () => {
  serveReport(() => reportSource);
  render(
    <AttachmentPreview target={{ id: reportFile.id }} onClose={() => {}} />,
  );
  const frame = await screen.findByLabelText("Report: E2E report");
  expect(invoke).toHaveBeenCalledWith("attachment_html", {
    workspace: "workspace",
    id: "report-1",
  });
  // An empty sandbox: no scripts, forms, popups or app origin.
  expect(frame.getAttribute("sandbox")).toBe("");
  expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
  const srcdoc = frame.getAttribute("srcdoc") ?? "";
  expect(srcdoc).toContain("default-src 'none'");
  expect(srcdoc).toContain("<table>");
  expect(srcdoc).not.toContain("<script");
  expect(
    screen.getByText("Scripts and online images are off in this preview."),
  ).toBeTruthy();
  // It never goes through the passive-media protocol.
  expect(screen.queryByRole("img")).toBeNull();
  // The facts say how it is shown.
  expect(screen.getByText(/Read-only, offline/)).toBeTruthy();
});

test("a report that needs scripts or files that are not attached can't show here", async () => {
  serveReport(() => '<div id="app"></div><script>render()</script>');
  render(
    <AttachmentPreview target={{ id: reportFile.id }} onClose={() => {}} />,
  );
  expect(await screen.findByText("This report can't show here")).toBeTruthy();
  expect(screen.queryByLabelText("Report: E2E report")).toBeNull();
  // Open stays in the header as the way to the full report.
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Open file" })
      .disabled,
  ).toBe(false);
});

test("a report that can't be read says so and retries", async () => {
  let attempt = 0;
  serveReport(() => {
    attempt += 1;
    if (attempt === 1) throw new Error("This report is not UTF-8 text.");
    return reportSource;
  });
  render(
    <AttachmentPreview target={{ id: reportFile.id }} onClose={() => {}} />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  expect(await screen.findByLabelText("Report: E2E report")).toBeTruthy();
});

test("Details stay behind … until asked, then I toggles them and the choice is kept", async () => {
  setPreference("attachmentDetails", false);
  serveReport(() => reportSource);
  const view = render(
    <AttachmentPreview target={{ id: reportFile.id }} onClose={() => {}} />,
  );
  await screen.findByLabelText("Report: E2E report");
  expect(screen.queryByRole("complementary", { name: "Details" })).toBeNull();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "i" });
  expect(screen.getByRole("complementary", { name: "Details" })).toBeTruthy();
  view.unmount();
  render(
    <AttachmentPreview target={{ id: reportFile.id }} onClose={() => {}} />,
  );
  await screen.findByLabelText("Report: E2E report");
  expect(screen.getByRole("complementary", { name: "Details" })).toBeTruthy();
});

test("closing with Escape puts the ticket back where it was", async () => {
  function Ticket() {
    const [open, setOpen] = useState(false);
    return (
      <div data-testid="pane">
        <button onClick={() => setOpen(true)}>Open report</button>
        {open && (
          <AttachmentPreview
            target={{ id: reportFile.id }}
            onClose={() => setOpen(false)}
          />
        )}
      </div>
    );
  }
  serveReport(() => reportSource);
  render(<Ticket />);
  // jsdom has no layout: a scroll position the test controls.
  const pane = screen.getByTestId("pane");
  let top = 320;
  Object.defineProperty(pane, "scrollTop", {
    get: () => top,
    set: (value: number) => {
      top = value;
    },
  });
  const opener = screen.getByRole("button", { name: "Open report" });
  opener.focus();
  fireEvent.click(opener);
  const viewer = await screen.findByRole("dialog");
  // The stage takes focus, named by its file and type.
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("group", { name: "E2E report, HTML" }),
    ),
  );
  top = 0; // the page moved while it was open
  fireEvent.keyDown(viewer, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(top).toBe(320);
  expect(document.activeElement).toBe(opener);
});

const pdfFile = {
  ...file,
  id: "pdf-1",
  display_name: "Refunds API",
  original_filename: "refunds.pdf",
  size_bytes: 52_000,
};
const pdfPreview = {
  attachment: pdfFile,
  status: "unsupported",
  media_type: null,
  message: "Preview unavailable for this format.",
  can_open: true,
  pdf: true,
  usage: { total: 0, entries: [], legacy_drafts_pending: false },
};
function servePdf() {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "attachment_workspace_id") return "workspace";
    if (command === "attachment_preview") return pdfPreview;
    if (command === "attachment_pdf") return new Uint8Array([37, 80, 68, 70]);
    return null;
  });
}

test("a PDF opens as pages with its view bar, and the original stays exportable", async () => {
  servePdf();
  const pdf = fakePdf(4);
  vi.mocked(openPdf).mockResolvedValue(pdf.document);
  render(<AttachmentPreview target={{ id: pdfFile.id }} onClose={() => {}} />);
  expect(await screen.findByRole("img", { name: "Page 4" })).toBeTruthy();
  expect(screen.getByText("of 4")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Fit" })).toBeTruthy();
  // It never goes through the passive-media protocol.
  expect(invoke).not.toHaveBeenCalledWith(
    "attachment_media",
    expect.anything(),
  );
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Export file" })
      .disabled,
  ).toBe(false);
  // The stage that holds the pages is the one that takes focus on open.
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("group", { name: "Refunds API, PDF" }),
    ),
  );
});

test("the page number is a text field: its keys type, and Esc leaves it before the viewer", async () => {
  setPreference("attachmentDetails", false);
  servePdf();
  vi.mocked(openPdf).mockResolvedValue(fakePdf(4).document);
  const close = vi.fn();
  render(<AttachmentPreview target={{ id: pdfFile.id }} onClose={close} />);
  const field = await screen.findByRole("textbox", { name: "Page" });
  field.focus();
  // O, I and the zoom keys are letters here, not the viewer's commands.
  fireEvent.keyDown(field, { key: "i" });
  expect(screen.queryByRole("complementary", { name: "Details" })).toBeNull();
  fireEvent.keyDown(field, { key: "Escape" });
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("group", { name: "Refunds API, PDF" }),
    ),
  );
  expect(close).not.toHaveBeenCalled();
  // A second Esc, now outside the field, closes the viewer.
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("a PDF that can't render shows the fallback and keeps Open and Export", async () => {
  servePdf();
  vi.mocked(openPdf).mockRejectedValue(new PdfUnreadable());
  render(<AttachmentPreview target={{ id: pdfFile.id }} onClose={() => {}} />);
  expect(await screen.findByText("Couldn't show this PDF")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Fit" })).toBeNull();
  for (const name of ["Open file", "Export file"])
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name }).disabled,
    ).toBe(false);
});

test("a PDF that isn't downloaded, missing or too large never reads its bytes", async () => {
  const states = [
    { ...pdfPreview, pdf: false, status: "too_large" },
    { ...pdfPreview, pdf: false, status: "missing" },
  ];
  for (const state of states) {
    vi.mocked(invoke).mockImplementation(async (command) =>
      command === "attachment_workspace_id" ? "workspace" : state,
    );
    const view = render(
      <AttachmentPreview target={{ id: pdfFile.id }} onClose={() => {}} />,
    );
    await screen.findByRole("dialog");
    await act(async () => {});
    expect(invoke).not.toHaveBeenCalledWith(
      "attachment_pdf",
      expect.anything(),
    );
    view.unmount();
  }
  expect(openPdf).not.toHaveBeenCalled();
});

const shot = {
  ...file,
  id: "shot-1",
  display_name: "refund.png",
  original_filename: "refund.png",
  size_bytes: 9_000,
};
const lost = {
  ...file,
  id: "lost-1",
  display_name: "trace.log",
  original_filename: "trace.log",
  size_bytes: 120,
};
const walk: Attachment[] = [shot, reportFile, pdfFile, lost];
const previews: Record<string, unknown> = {
  [shot.id]: {
    attachment: shot,
    status: "available",
    media_type: "image/png",
    message: null,
    can_open: true,
    usage: { total: 0, entries: [], legacy_drafts_pending: false },
  },
  [reportFile.id]: reportPreview,
  [pdfFile.id]: pdfPreview,
  [lost.id]: {
    attachment: lost,
    status: "unavailable",
    media_type: null,
    message: "The stored copy can't be read.",
    can_open: false,
    usage: { total: 0, entries: [], legacy_drafts_pending: false },
  },
};
function serveWalk() {
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "attachment_workspace_id") return "workspace";
    if (command === "attachment_preview")
      return previews[(args as { id: string }).id];
    if (command === "attachment_html") return reportSource;
    if (command === "attachment_pdf") return new Uint8Array([37, 80, 68, 70]);
    return null;
  });
}
/** The ticket that opened the viewer: it picks the shown file, like Ticket Files. */
function Walk({ start, onClose }: { start: number; onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(walk[start]!);
  return (
    <div data-testid="pane">
      <button onClick={() => setOpen(true)}>Open file</button>
      {open && (
        <AttachmentPreview
          target={{ id: shown.id, initial: shown }}
          browse={{ files: walk, onSelect: setShown }}
          onClose={() => {
            setOpen(false);
            onClose?.();
          }}
        />
      )}
    </div>
  );
}
const header = () => screen.getByRole("group", { name: "Browse files" });

test("browsing a mixed set: each file shows its own state and recovery, J and K step, the ends hold", async () => {
  serveWalk();
  vi.mocked(openPdf).mockResolvedValue(fakePdf(3).document);
  render(<Walk start={1} />);
  fireEvent.click(screen.getByRole("button", { name: "Open file" }));
  // The report is second of four: its position and both buttons are there.
  await screen.findByLabelText("Report: E2E report");
  expect(header().textContent).toContain("2 of 4");
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Previous file" })
      .disabled,
  ).toBe(false);
  const viewer = screen.getByRole("dialog");
  // Both neighbors were read ahead, so a step has its state at once.
  await waitFor(() => {
    for (const id of [shot.id, pdfFile.id])
      expect(invoke).toHaveBeenCalledWith("attachment_preview", {
        workspace: "workspace",
        id,
      });
  });
  // J: the PDF, with its pages and bar; the report's frame is gone.
  fireEvent.keyDown(viewer, { key: "j" });
  expect(await screen.findByRole("img", { name: "Page 3" })).toBeTruthy();
  expect(screen.queryByLabelText("Report: E2E report")).toBeNull();
  expect(header().textContent).toContain("3 of 4");
  expect(screen.getByRole("heading", { name: "Refunds API" })).toBeTruthy();
  // The unavailable file brings its own recovery and none of the PDF's controls.
  fireEvent.click(screen.getByRole("button", { name: "Next file" }));
  expect(await screen.findByText("Couldn't read this file")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Fit" })).toBeNull();
  expect(screen.queryByRole("img", { name: "Page 3" })).toBeNull();
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Open file" })
      .disabled,
  ).toBe(true);
  // The last file: Next is disabled and says so, and J does nothing.
  expect(header().textContent).toContain("4 of 4");
  expect(
    header().querySelector<HTMLButtonElement>("[aria-label='Next file']")
      ?.disabled,
  ).toBe(true);
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "j" });
  expect(header().textContent).toContain("4 of 4");
  // Focus did not stay on a button that just stopped working.
  expect(document.activeElement).toBe(
    screen.getByRole("group", { name: "trace.log, Log, 4 of 4" }),
  );
  // K walks back to the screenshot, a clean slate: no failure left over.
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "k" });
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "k" });
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "k" });
  await waitFor(() =>
    expect(screen.getByRole("img", { name: "refund.png" })).toBeTruthy(),
  );
  expect(screen.queryByText("Couldn't read this file")).toBeNull();
  expect(header().textContent).toContain("1 of 4");
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "k" });
  expect(header().textContent).toContain("1 of 4");
  // Each step was announced politely.
  expect(document.querySelector("[aria-live='polite']")?.textContent).toContain(
    "refund.png, PNG image, 1 of 4",
  );
});

test("J and K are typing in the page number field and never switch files", async () => {
  serveWalk();
  vi.mocked(openPdf).mockResolvedValue(fakePdf(4).document);
  render(<Walk start={2} />);
  fireEvent.click(screen.getByRole("button", { name: "Open file" }));
  const field = await screen.findByRole("textbox", { name: "Page" });
  field.focus();
  fireEvent.keyDown(field, { key: "j" });
  fireEvent.keyDown(field, { key: "k" });
  expect(header().textContent).toContain("3 of 4");
  // Arrows and the zoom keys stay the stage's: they never change the file.
  const stage = screen.getByRole("group", { name: /^Refunds API, PDF/ });
  fireEvent.keyDown(stage, { key: "ArrowRight" });
  fireEvent.keyDown(stage, { key: "ArrowDown" });
  fireEvent.keyDown(stage, { key: "+" });
  expect(header().textContent).toContain("3 of 4");
});

test("a lone file has no position or buttons, and J does nothing", async () => {
  serveWalk();
  render(
    <AttachmentPreview
      target={{ id: shot.id, initial: shot }}
      browse={{ files: [shot], onSelect: () => {} }}
      onClose={() => {}}
    />,
  );
  await screen.findByRole("img", { name: "refund.png" });
  expect(screen.queryByRole("group", { name: "Browse files" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Next file" })).toBeNull();
});

test("closing after stepping returns focus and scroll to what opened the viewer", async () => {
  serveWalk();
  vi.mocked(openPdf).mockResolvedValue(fakePdf(2).document);
  render(<Walk start={0} />);
  const pane = screen.getByTestId("pane");
  let top = 480;
  Object.defineProperty(pane, "scrollTop", {
    get: () => top,
    set: (value: number) => {
      top = value;
    },
  });
  const opener = screen.getByRole("button", { name: "Open file" });
  opener.focus();
  fireEvent.click(opener);
  await screen.findByRole("img", { name: "refund.png" });
  fireEvent.click(screen.getByRole("button", { name: "Next file" }));
  await screen.findByLabelText("Report: E2E report");
  fireEvent.click(screen.getByRole("button", { name: "Next file" }));
  await screen.findByRole("heading", { name: "Refunds API" });
  top = 0;
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(top).toBe(480);
  expect(document.activeElement).toBe(opener);
});

const runLog: Attachment = {
  ...file,
  id: "run-1",
  display_name: "e2e-run.log",
  original_filename: "e2e-run.log",
  size_bytes: 40_000_000,
};
const runText = Array.from({ length: 90 }, (_, line) =>
  line % 30 === 4 ? `line ${line} FAIL checkout` : `line ${line} ok`,
).join("\n");
function serveLog() {
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "attachment_workspace_id") return "workspace";
    if (command === "attachment_preview")
      return (args as { id: string }).id === runLog.id
        ? {
            attachment: runLog,
            status: "unsupported",
            media_type: null,
            message: null,
            can_open: true,
            text_excerpt: { text: "line 0 ok", truncated: true },
            text: {
              total_bytes: 240 * 1024 * 1024,
              shown_bytes: 5 * 1024 * 1024,
              partial: true,
            },
            usage: { total: 0, entries: [], legacy_drafts_pending: false },
          }
        : previews[(args as { id: string }).id];
    if (command === "attachment_text") return new TextEncoder().encode(runText);
    return null;
  });
}

test("a long log shows its scope and keeps Open and Export, and Find leaves browsing and Esc alone", async () => {
  setPreference("attachmentDetails", false);
  serveLog();
  const files = [runLog, shot];
  const closed = vi.fn();
  function Browse() {
    const [shown, setShown] = useState(runLog);
    return (
      <AttachmentPreview
        target={{ id: shown.id, initial: shown }}
        browse={{ files, onSelect: setShown }}
        onClose={closed}
      />
    );
  }
  render(<Browse />);
  expect(
    await screen.findByText(
      "Showing the last 5 MB of 240 MB. Open it in its app for the rest.",
    ),
  ).toBeTruthy();
  // The original stays one action away.
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Open file" })
      .disabled,
  ).toBe(false);
  expect(screen.getByRole("button", { name: "Export file" })).toBeTruthy();
  const viewer = screen.getByRole("dialog");
  const stage = await screen.findByRole("group", {
    name: "e2e-run.log, Log, 1 of 2",
  });
  await waitFor(() => expect(document.activeElement).toBe(stage));

  // ⌘F-style find: J and K are letters in the field, not file steps.
  fireEvent.keyDown(stage, { key: "/" });
  const field = await screen.findByRole("textbox", {
    name: "Find in the text",
  });
  fireEvent.change(field, { target: { value: "fail" } });
  await waitFor(() =>
    expect(screen.getByRole("status", { name: "" }).textContent).toBe("1 of 3"),
  );
  fireEvent.keyDown(field, { key: "j" });
  expect(header().textContent).toContain("1 of 2");
  // Esc leaves Find first and keeps the viewer open.
  fireEvent.keyDown(field, { key: "Escape" });
  expect(
    screen.queryByRole("textbox", { name: "Find in the text" }),
  ).toBeNull();
  expect(closed).not.toHaveBeenCalled();
  await waitFor(() => expect(document.activeElement).toBe(stage));
  // Back on the stage, J walks to the next file, and K returns.
  fireEvent.keyDown(viewer, { key: "j" });
  expect(await screen.findByRole("img", { name: "refund.png" })).toBeTruthy();
  expect(header().textContent).toContain("2 of 2");
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "k" });
  expect(
    await screen.findByRole("document", { name: "Text of e2e-run.log" }),
  ).toBeTruthy();
});
