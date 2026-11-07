// @vitest-environment jsdom
import { IDBFactory } from "fake-indexeddb";
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
import { MarkdownDocument } from "@/features/markdown/MarkdownDocument";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: vi.fn(),
}));
beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const oldUri = "ticketd://attachment/workspace/old";
const newUri = "ticketd://attachment/workspace/new";
const file = {
  id: "old",
  display_name: "Missing screenshot",
  original_filename: "screen.png",
  size_bytes: 42,
  kind: "local_snapshot",
  locator: "old/bytes/screen.png",
};

function bridge() {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "attachment_workspace_id") return "workspace";
    if (command === "resolve_attachment_uri") return file;
    if (command === "attachment_preview")
      return {
        attachment: file,
        status: "missing",
        media_type: null,
        message: "Stored file is missing.",
        can_open: false,
        usage: { total: 0, entries: [], legacy_drafts_pending: false },
      };
    if (command === "attachment_upload_limit") return 104857600;
    if (command === "search_attachments")
      return [{ ...file, id: "new", display_name: "Replacement" }].map(
        (attachment) => ({
          attachment,
          related: false,
          usage: {
            eligible: true,
            legacy_drafts_pending: false,
            protections: [],
          },
        }),
      );
    if (command === "inspect_attachment")
      return { ...file, id: "new", display_name: "Replacement" };
    if (command === "attachment_uri") return newUri;
    return null;
  });
}

test("replacement changes only the chosen inline occurrence and preserves image syntax and authored labels", async () => {
  bridge();
  const change = vi.fn();
  const source = `Before [Keep **this**](${oldUri}) and ![Chosen label](${oldUri}) after.`;
  render(<MarkdownDocument source={source} onChange={change} />);
  fireEvent.click(screen.getByRole("button", { name: "Chosen label" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Choose a replacement" }),
  );
  fireEvent.click(screen.getByRole("radio", { name: "Existing files" }));
  fireEvent.click(
    await screen.findByRole("radio", { name: "Select Replacement" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Insert selected" }));
  await waitFor(() =>
    expect(change).toHaveBeenCalledWith(
      `Before [Keep **this**](${oldUri}) and ![Chosen label](${newUri}) after.`,
      expect.any(AbortSignal),
    ),
  );
  expect(invoke).not.toHaveBeenCalledWith("open_attachment", expect.anything());
});

test("replacement refuses a changed draft rather than guessing which reference moved", async () => {
  bridge();
  const change = vi.fn();
  const source = `[Chosen](${oldUri}) and [Other](${oldUri})`;
  const view = render(<MarkdownDocument source={source} onChange={change} />);
  fireEvent.click(screen.getByRole("button", { name: "Chosen" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Choose a replacement" }),
  );
  view.rerender(
    <MarkdownDocument source={`${source} changed`} onChange={change} />,
  );
  fireEvent.click(screen.getByRole("radio", { name: "Existing files" }));
  fireEvent.click(
    await screen.findByRole("radio", { name: "Select Replacement" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Insert selected" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "content changed",
  );
  expect(change).not.toHaveBeenCalled();
});

test("shared reference definitions stay intact when one reference-style use is replaced", async () => {
  bridge();
  const change = vi.fn();
  const source = `Before [Chosen][file] and [Keep][file].\n\n[file]: ${oldUri}\n`;
  render(<MarkdownDocument source={source} onChange={change} />);
  fireEvent.click(screen.getByRole("button", { name: "Chosen" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Choose a replacement" }),
  );
  fireEvent.click(screen.getByRole("radio", { name: "Existing files" }));
  fireEvent.click(
    await screen.findByRole("radio", { name: "Select Replacement" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Insert selected" }));
  await waitFor(() =>
    expect(change).toHaveBeenCalledWith(
      `Before [Chosen](${newUri}) and [Keep][file].\n\n[file]: ${oldUri}\n`,
      expect.any(AbortSignal),
    ),
  );
});

test("a destination-shaped label and an inline title survive selected replacement literally", async () => {
  bridge();
  const change = vi.fn();
  const source = `[Chosen \\](${oldUri}) label](${oldUri} "keep title")`;
  render(<MarkdownDocument source={source} onChange={change} />);
  fireEvent.click(screen.getByRole("button", { name: /^Chosen/ }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Choose a replacement" }),
  );
  fireEvent.click(screen.getByRole("radio", { name: "Existing files" }));
  fireEvent.click(
    await screen.findByRole("radio", { name: "Select Replacement" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Insert selected" }));
  await waitFor(() =>
    expect(change).toHaveBeenCalledWith(
      `[Chosen \\](${oldUri}) label](${newUri} "keep title")`,
      expect.any(AbortSignal),
    ),
  );
});

test("canceling a pending replacement leaves the original reference intact", async () => {
  bridge();
  const bridgeInvoke = vi.mocked(invoke).getMockImplementation();
  let complete: ((value: string) => void) | undefined;
  const pendingUri = new Promise<string>((resolve) => {
    complete = resolve;
  });
  vi.mocked(invoke).mockImplementation((command, args, options) =>
    command === "attachment_uri"
      ? pendingUri
      : bridgeInvoke!(command, args, options),
  );
  const change = vi.fn();
  render(<MarkdownDocument source={`[Chosen](${oldUri})`} onChange={change} />);
  fireEvent.click(screen.getByRole("button", { name: "Chosen" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Choose a replacement" }),
  );
  fireEvent.click(screen.getByRole("radio", { name: "Existing files" }));
  fireEvent.click(
    await screen.findByRole("radio", { name: "Select Replacement" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Insert selected" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("attachment_uri", { id: "new" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await act(async () => complete?.(newUri));
  expect(change).not.toHaveBeenCalled();
});
