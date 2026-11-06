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
import { Channel, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { AttachmentPicker } from "./AttachmentPicker";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage = () => {};
  },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const file = (name: string) => ({
  id: name,
  display_name: name,
  original_filename: name,
  size_bytes: 7,
  kind: "local_snapshot",
  locator: `${name}/bytes/${name}`,
});

test("mixed batches insert successes in selection order and retry the original failed operation before later files", async () => {
  vi.mocked(open).mockResolvedValue([
    "C:/first.txt",
    "C:/bad.txt",
    "C:/last.txt",
  ]);
  let fails = true;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "attachment_upload_limit") return 104857600;
    const source = String((args as Record<string, unknown>)?.source);
    if (source.endsWith("bad.txt") && fails) throw new Error("Disk full");
    return file(source.split("/").at(-1)!);
  });
  const picked = vi
    .fn<
      (file: unknown, requestId: string, beforeId?: string) => Promise<void>
    >()
    .mockResolvedValue(undefined);
  render(<AttachmentPicker open onOpenChange={() => {}} onPick={picked} />);
  fireEvent.click(screen.getByRole("button", { name: "Choose files" }));
  await screen.findByText("Disk full");
  await waitFor(() => expect(picked.mock.calls).toHaveLength(2));
  expect(picked.mock.calls.map((call) => call[0])).toEqual([
    file("first.txt"),
    file("last.txt"),
  ]);
  const original = vi
    .mocked(invoke)
    .mock.calls.find(
      ([, args]) => (args as Record<string, unknown>)?.source === "C:/bad.txt",
    )?.[1];
  fails = false;
  fireEvent.click(
    within(screen.getByRole("listitem", { name: "bad.txt" })).getByRole(
      "button",
      { name: "Retry" },
    ),
  );
  await waitFor(() => expect(picked.mock.calls).toHaveLength(3));
  expect(picked).toHaveBeenLastCalledWith(
    file("bad.txt"),
    expect.any(String),
    "last.txt",
  );
  const retries = vi
    .mocked(invoke)
    .mock.calls.filter(
      ([command, args]) =>
        command === "import_attachment" &&
        (args as Record<string, unknown>)?.source === "C:/bad.txt",
    );
  expect((retries[1]?.[1] as Record<string, unknown>)?.requestId).toBe(
    (original as Record<string, unknown>)?.requestId,
  );
  expect(open).toHaveBeenCalledWith(
    expect.objectContaining({ multiple: true }),
  );
});

test("canceling one file suppresses late insertion, preserves its completed snapshot and retries without copying again", async () => {
  vi.mocked(open).mockResolvedValue(["C:/first.txt", "C:/last.txt"]);
  let complete: ((value: ReturnType<typeof file>) => void) | undefined;
  const pending = new Promise<ReturnType<typeof file>>((resolve) => {
    complete = resolve;
  });
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "attachment_upload_limit") return 104857600;
    if (command === "cancel_attachment_upload") return;
    const params = args as Record<string, unknown>;
    if (params.source === "C:/first.txt") {
      (params.progress as Channel<unknown>).onmessage({ copied: 3, total: 7 });
      return pending;
    }
    return file("last.txt");
  });
  const picked = vi
    .fn<
      (file: unknown, requestId: string, beforeId?: string) => Promise<void>
    >()
    .mockResolvedValue(undefined);
  render(<AttachmentPicker open onOpenChange={() => {}} onPick={picked} />);
  fireEvent.click(screen.getByRole("button", { name: "Choose files" }));
  const progress = await screen.findByRole("progressbar", {
    name: "Upload first.txt",
  });
  await waitFor(() => expect(progress.getAttribute("value")).toBe("3"));
  fireEvent.click(
    within(screen.getByRole("listitem", { name: "first.txt" })).getByRole(
      "button",
      { name: "Cancel" },
    ),
  );
  complete?.(file("first.txt"));
  await waitFor(() => expect(picked.mock.calls).toHaveLength(1));
  expect(picked.mock.calls[0]?.[0]).toEqual(file("last.txt"));
  await screen.findByText(/Stored as first.txt/);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(picked.mock.calls).toHaveLength(2));
  expect(picked).toHaveBeenLastCalledWith(
    file("first.txt"),
    expect.any(String),
    "last.txt",
  );
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === "import_attachment"),
  ).toHaveLength(2);
});
