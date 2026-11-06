// @vitest-environment jsdom
import { IDBFactory } from "fake-indexeddb";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
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
beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
});
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

test("Drive failures retain their folder and operation; status checks precede retry and local fallback is explicit", async () => {
  const destination = {
    connection_id: "connection",
    folder_id: "folder",
    resource_key: null,
  };
  let fail = true;
  vi.mocked(open).mockResolvedValue(["C:/trace.log"]);
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "attachment_workspace_id") return "drive-workspace";
    if (command === "attachment_upload_limit") return 104857600;
    if (command === "select_drive_upload_folder")
      return {
        destination,
        folder: {
          id: "folder",
          name: "ticketd attachments",
          can_add_children: true,
        },
      };
    if (command === "check_drive_upload")
      return { state: "uncertain", attachment: null };
    if (command === "upload_drive_file") {
      if (fail)
        throw new Error("Completion uncertain. Check status before retrying.");
      return {
        ...file("trace.log"),
        kind: "external_reference",
        locator: "drive:connection:reserved",
      };
    }
    return file("trace.log");
  });
  const picked = vi.fn().mockResolvedValue(undefined);
  render(<AttachmentPicker open onOpenChange={() => {}} onPick={picked} />);
  fireEvent.click(screen.getByRole("button", { name: "Choose Drive folder" }));
  await screen.findByText(/Destination: Google Drive/);
  fireEvent.click(screen.getByRole("button", { name: "Choose files" }));
  const row = await screen.findByRole("listitem", { name: "trace.log" });
  await within(row).findByText(/Completion uncertain/);
  expect(picked).not.toHaveBeenCalled();
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(([command]) => command === "import_attachment"),
  ).toBe(false);
  const original = vi
    .mocked(invoke)
    .mock.calls.find(([command]) => command === "upload_drive_file")?.[1];
  fireEvent.click(within(row).getByRole("button", { name: "Check status" }));
  await within(row).findByText(/Not confirmed complete/);
  fail = false;
  fireEvent.click(within(row).getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(picked).toHaveBeenCalledTimes(1));
  const requests = vi
    .mocked(invoke)
    .mock.calls.filter(([command]) => command === "upload_drive_file");
  expect(requests[1]?.[1]).toMatchObject({
    requestId: (original as { requestId: string }).requestId,
    destination,
  });
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(([command]) => command === "import_attachment"),
  ).toBe(false);
});

test("explicit local fallback uses a new operation and retains the original Drive recovery record after remount", async () => {
  const destination = {
    connection_id: "connection",
    folder_id: "original-folder",
    resource_key: null,
  };
  vi.mocked(open).mockResolvedValue(["C:/trace.log"]);
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "attachment_workspace_id") return "fallback-workspace";
    if (command === "attachment_upload_limit") return 104857600;
    if (command === "select_drive_upload_folder")
      return {
        destination,
        folder: {
          id: "original-folder",
          name: "Uploads",
          can_add_children: true,
        },
      };
    if (command === "upload_drive_file") throw new Error("Drive offline");
    return file("trace.log");
  });
  const picked = vi.fn().mockResolvedValue(undefined);
  const first = render(
    <AttachmentPicker open onOpenChange={() => {}} onPick={picked} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Choose Drive folder" }));
  await screen.findByText(/Destination: Google Drive/);
  fireEvent.click(screen.getByRole("button", { name: "Choose files" }));
  await screen.findByText("Drive offline");
  fireEvent.click(
    screen.getByRole("button", { name: "Upload locally instead" }),
  );
  await waitFor(() => expect(picked).toHaveBeenCalledTimes(1));
  const remote = vi
    .mocked(invoke)
    .mock.calls.find(([command]) => command === "upload_drive_file")?.[1] as {
    requestId: string;
  };
  const local = vi
    .mocked(invoke)
    .mock.calls.find(([command]) => command === "import_attachment")?.[1] as {
    requestId: string;
  };
  expect(remote.requestId).not.toBe(local.requestId);
  expect(
    screen.getByText(
      /Any completed remote file remains in Drive; this Drive operation is retained/,
    ),
  ).toBeTruthy();
  first.unmount();
  render(<AttachmentPicker open onOpenChange={() => {}} onPick={picked} />);
  await screen.findByText(/Folder original-folder/);
  expect(screen.getByRole("button", { name: "Check status" })).toBeTruthy();
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === "upload_drive_file"),
  ).toHaveLength(1);
});

test("interrupted uploads recover original identities after remount and stay isolated by workspace", async () => {
  let workspace = "first-workspace";
  const requests: string[] = [];
  let interrupted = true;
  vi.mocked(open).mockResolvedValue(["C:/recover.txt", "C:/queued.txt"]);
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "attachment_workspace_id") return workspace;
    if (command === "attachment_upload_limit") return 104857600;
    const params = args as Record<string, unknown>;
    requests.push(String(params.requestId));
    if (interrupted) return new Promise(() => {});
    return file(String(params.source).split("/").at(-1)!);
  });
  const picked = vi
    .fn<
      (file: unknown, requestId: string, beforeId?: string) => Promise<void>
    >()
    .mockResolvedValue(undefined);
  const mount = () =>
    render(<AttachmentPicker open onOpenChange={() => {}} onPick={picked} />);
  const first = mount();
  fireEvent.click(screen.getByRole("button", { name: "Choose files" }));
  await waitFor(() => expect(requests).toHaveLength(1));
  const original = requests[0];
  first.unmount();
  workspace = "another-workspace";
  const another = mount();
  await screen.findByText(/Up to/);
  expect(screen.queryByRole("listitem", { name: "recover.txt" })).toBeNull();
  another.unmount();
  workspace = "first-workspace";
  const recovered = mount();
  const row = await screen.findByRole("listitem", { name: "recover.txt" });
  expect(
    await screen.findByRole("listitem", { name: "queued.txt" }),
  ).toBeTruthy();
  expect(picked).not.toHaveBeenCalled();
  interrupted = false;
  fireEvent.click(within(row).getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(picked).toHaveBeenCalled());
  expect(requests).toEqual([original, original]);
  recovered.unmount();
  mount();
  await screen.findByRole("listitem", { name: "queued.txt" });
  expect(screen.queryByRole("listitem", { name: "recover.txt" })).toBeNull();
});

test("unavailable recovery storage blocks new uploads instead of losing retry identity", async () => {
  vi.stubGlobal("indexedDB", undefined);
  vi.mocked(open).mockResolvedValue(["C:/unsafe.txt"]);
  vi.mocked(invoke).mockResolvedValue(104857600);
  render(
    <AttachmentPicker open onOpenChange={() => {}} onPick={async () => {}} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Choose files" }));
  await screen.findByText(/No new uploads were started/);
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(([command]) => command === "import_attachment"),
  ).toBe(false);
});

test("mixed batches insert successes in selection order and retry the original failed operation before later files", async () => {
  vi.mocked(open).mockResolvedValue([
    "C:/first.txt",
    "C:/bad.txt",
    "C:/last.txt",
  ]);
  let fails = true;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "attachment_workspace_id") return "workspace-test";
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
    if (command === "attachment_workspace_id") return "workspace-test";
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
