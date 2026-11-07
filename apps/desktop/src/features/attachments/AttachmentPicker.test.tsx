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

test("new captures use the current workspace preference while recovered retries keep their original destination", async () => {
  const drive = {
    kind: "google_drive",
    destination: {
      connection_id: "account",
      folder_id: "folder",
      resource_key: null,
    },
    folder_name: "Team uploads",
  };
  let preference: unknown = drive;
  const bindings = new Map<string, unknown>();
  vi.mocked(open).mockResolvedValue(["C:/trace.log"]);
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "attachment_workspace_id") return "defaults-workspace";
    if (command === "attachment_upload_limit") return 104857600;
    if (command === "attachment_upload_destination") return preference;
    if (command === "begin_attachment_upload") {
      const { requestId, explicit } = args as {
        requestId: string;
        explicit: unknown;
      };
      const selected = bindings.get(requestId) ?? explicit ?? preference;
      bindings.set(requestId, selected);
      return selected;
    }
    if (command === "upload_drive_file")
      throw new Error("Offline; retry Drive");
    if (command === "import_attachment") return file("trace.log");
    return null;
  });
  const view = render(
    <AttachmentPicker open onOpenChange={() => {}} onPick={async () => {}} />,
  );
  await screen.findByText("Destination: Google Drive · Team uploads");
  fireEvent.click(screen.getByRole("button", { name: "Choose files" }));
  const row = await screen.findByRole("listitem", { name: "trace.log" });
  await within(row).findByText(/Offline/);
  const original = vi
    .mocked(invoke)
    .mock.calls.find(([command]) => command === "upload_drive_file")?.[1];
  view.unmount();
  preference = { kind: "local" };
  render(
    <AttachmentPicker open onOpenChange={() => {}} onPick={async () => {}} />,
  );
  await screen.findByText("Destination: Local workspace");
  const recovered = await screen.findByRole("listitem", { name: "trace.log" });
  fireEvent.click(within(recovered).getByRole("button", { name: "Retry" }));
  await within(recovered).findByText(/Offline/);
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(
        ([command]) => command === "upload_drive_file",
      )[1]?.[1],
  ).toMatchObject({
    requestId: (original as { requestId: string }).requestId,
    destination: drive.destination,
  });
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(([command]) => command === "import_attachment"),
  ).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Choose files" }));
  await waitFor(() =>
    expect(
      vi
        .mocked(invoke)
        .mock.calls.some(([command]) => command === "import_attachment"),
    ).toBe(true),
  );
});

test("a failed destination binding retries resolution before any upload and never assumes local storage", async () => {
  const drive = {
    kind: "google_drive",
    destination: {
      connection_id: "account",
      folder_id: "folder",
      resource_key: null,
    },
    folder_name: "Team files",
  };
  let bindingFailed = true;
  vi.mocked(open).mockResolvedValue(["C:/trace.log"]);
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "attachment_workspace_id") return "binding-retry";
    if (command === "attachment_upload_limit") return 104857600;
    if (command === "attachment_upload_destination") return drive;
    if (command === "begin_attachment_upload") {
      if (bindingFailed) throw new Error("Workspace is temporarily read-only");
      return drive;
    }
    if (command === "upload_drive_file") throw new Error("Drive is offline");
    return null;
  });
  render(
    <AttachmentPicker open onOpenChange={() => {}} onPick={async () => {}} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Choose files" }));
  const row = await screen.findByRole("listitem", { name: "trace.log" });
  await within(row).findByText(/temporarily read-only/);
  bindingFailed = false;
  fireEvent.click(within(row).getByRole("button", { name: "Retry" }));
  await within(row).findByText(/Drive is offline/);
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(([command]) => command === "import_attachment"),
  ).toBe(false);
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === "begin_attachment_upload"),
  ).toHaveLength(2);
});

test("Drive failures retain their folder and operation; status checks precede retry and local fallback is explicit", async () => {
  const destination = {
    connection_id: "connection",
    folder_id: "folder",
    resource_key: null,
  };
  let fail = true;
  vi.mocked(open).mockResolvedValue(["C:/trace.log"]);
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "attachment_upload_destination") return { kind: "local" };
    if (command === "begin_attachment_upload")
      return (args as { explicit?: unknown })?.explicit ?? { kind: "local" };
    if (command === "attachment_workspace_id") return "drive-workspace";
    if (command === "attachment_upload_limit") return 104857600;
    if (command === "drive_configuration")
      return { configured: true, message: "Ready to select a folder" };
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

test("unmount cancels an unfinished Drive folder selection without starting uploads", async () => {
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "attachment_upload_destination") return { kind: "local" };
    if (command === "begin_attachment_upload")
      return (args as { explicit?: unknown })?.explicit ?? { kind: "local" };
    if (command === "attachment_workspace_id") return "folder-cancel";
    if (command === "attachment_upload_limit") return 104857600;
    if (command === "drive_configuration")
      return { configured: true, message: "Ready to select a folder" };
    if (command === "select_drive_upload_folder") return new Promise(() => {});
    return null;
  });
  const view = render(
    <AttachmentPicker open onOpenChange={() => {}} onPick={async () => {}} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Choose Drive folder" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      "select_drive_upload_folder",
      expect.anything(),
    ),
  );
  const request = vi
    .mocked(invoke)
    .mock.calls.find(
      ([command]) => command === "select_drive_upload_folder",
    )?.[1];
  view.unmount();
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("cancel_drive_selection", request),
  );
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(([command]) => command === "upload_drive_file"),
  ).toBe(false);
});

test("explicit local fallback uses a new operation and retains the original Drive recovery record after remount", async () => {
  const destination = {
    connection_id: "connection",
    folder_id: "original-folder",
    resource_key: null,
  };
  vi.mocked(open).mockResolvedValue(["C:/trace.log"]);
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "attachment_upload_destination") return { kind: "local" };
    if (command === "begin_attachment_upload")
      return (args as { explicit?: unknown })?.explicit ?? { kind: "local" };
    if (command === "attachment_workspace_id") return "fallback-workspace";
    if (command === "attachment_upload_limit") return 104857600;
    if (command === "drive_configuration")
      return { configured: true, message: "Ready to select a folder" };
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
  await screen.findByText(/Google Drive · Uploads · Uploaded copy/);
  expect(screen.getByRole("button", { name: "Check status" })).toBeTruthy();
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === "upload_drive_file"),
  ).toHaveLength(1);
});

test("existing files search keeps related usage distinct and inserts selected identities in selection order", async () => {
  const related = file("ticket.log");
  const recent = file("recent.png");
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "attachment_upload_destination") return { kind: "local" };
    if (command === "begin_attachment_upload")
      return (args as { explicit?: unknown })?.explicit ?? { kind: "local" };
    if (command === "attachment_workspace_id") return "workspace-test";
    if (command === "attachment_upload_limit") return 104857600;
    if (command === "search_attachments")
      return [
        {
          attachment: related,
          related: true,
          usage: {
            eligible: false,
            legacy_drafts_pending: false,
            protections: [
              {
                kind: "document_body",
                owner: "document",
                ticket_id: null,
                trashed: true,
              },
            ],
          },
        },
        {
          attachment: recent,
          related: false,
          usage: {
            eligible: true,
            legacy_drafts_pending: false,
            protections: [],
          },
        },
      ];
    if (command === "inspect_attachment")
      return (args as { id: string }).id === related.id ? related : recent;
    throw new Error(`Unexpected ${command}`);
  });
  const picked = vi.fn().mockResolvedValue(undefined);
  const closed = vi.fn();
  render(
    <AttachmentPicker
      open
      ticketReference="T-1"
      onOpenChange={closed}
      onPick={picked}
    />,
  );
  fireEvent.click(screen.getByRole("radio", { name: "Existing files" }));
  await screen.findByText("Related to this ticket");
  expect(
    screen.getByText(/Document · not a direct ticket attachment · in Trash/),
  ).toBeTruthy();
  fireEvent.change(
    screen.getByRole("searchbox", { name: "Search existing files" }),
    { target: { value: "log" } },
  );
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("search_attachments", {
      query: expect.objectContaining({
        search: "log",
        ticket: "T-1",
        limit: 50,
      }),
    }),
  );
  fireEvent.click(
    await screen.findByRole("checkbox", { name: "Select recent.png" }),
  );
  fireEvent.click(screen.getByRole("checkbox", { name: "Select ticket.log" }));
  fireEvent.click(screen.getByRole("button", { name: "Insert selected" }));
  await waitFor(() => expect(closed).toHaveBeenCalledWith(false));
  expect(
    picked.mock.calls.map((call) => (call[0] as { id: string }).id),
  ).toEqual([recent.id, related.id]);
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(([command]) => command === "import_attachment"),
  ).toBe(false);
});

test("a completed reuse cannot close a newer insertion session", async () => {
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "attachment_upload_destination") return { kind: "local" };
    if (command === "begin_attachment_upload")
      return (args as { explicit?: unknown })?.explicit ?? { kind: "local" };
    if (command === "attachment_workspace_id") return "workspace-test";
    if (command === "attachment_upload_limit") return 104857600;
    if (command === "search_attachments") return [];
    return file("file.txt");
  });
  let finish: (() => void) | undefined;
  const picked = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const closed = vi.fn();
  const view = render(
    <AttachmentPicker open onOpenChange={closed} onPick={picked} />,
  );
  fireEvent.click(screen.getByRole("radio", { name: "Existing files" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Attachment ID" }), {
    target: { value: "file.txt" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Reuse ID" }));
  await waitFor(() => expect(picked).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  view.rerender(
    <AttachmentPicker open={false} onOpenChange={closed} onPick={picked} />,
  );
  view.rerender(
    <AttachmentPicker open onOpenChange={closed} onPick={picked} />,
  );
  closed.mockClear();
  finish?.();
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Reuse ID" }).hasAttribute("disabled"),
    ).toBe(false),
  );
  expect(closed).not.toHaveBeenCalled();
});

test("replacement mode selects one existing file before changing a reference", async () => {
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "attachment_upload_destination") return { kind: "local" };
    if (command === "begin_attachment_upload")
      return (args as { explicit?: unknown })?.explicit ?? { kind: "local" };
    if (command === "attachment_workspace_id") return "workspace";
    if (command === "attachment_upload_limit") return 104857600;
    if (command === "search_attachments")
      return ["first.txt", "second.txt"].map((name) => ({
        attachment: file(name),
        related: false,
        usage: {
          eligible: true,
          legacy_drafts_pending: false,
          protections: [],
        },
      }));
    if (command === "inspect_attachment")
      return file((args as { id: string }).id);
    throw new Error(`Unexpected ${command}`);
  });
  const picked = vi.fn().mockResolvedValue(undefined);
  render(
    <AttachmentPicker open single onOpenChange={() => {}} onPick={picked} />,
  );
  fireEvent.click(screen.getByRole("radio", { name: "Existing files" }));
  fireEvent.click(
    await screen.findByRole("radio", { name: "Select first.txt" }),
  );
  fireEvent.click(screen.getByRole("radio", { name: "Select second.txt" }));
  fireEvent.click(screen.getByRole("button", { name: "Insert selected" }));
  await waitFor(() => expect(picked).toHaveBeenCalledOnce());
  expect(picked.mock.calls[0]?.[0]).toEqual(file("second.txt"));
});

test("legacy-shaped local capture queues keep their destination under a new Drive default after remount", async () => {
  let workspace = "first-workspace";
  let driveDefault = false;
  const requests: string[] = [];
  let interrupted = true;
  vi.mocked(open).mockResolvedValue(["C:/recover.txt", "C:/queued.txt"]);
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "attachment_upload_destination")
      return driveDefault
        ? {
            kind: "google_drive",
            destination: {
              connection_id: "account",
              folder_id: "folder",
              resource_key: null,
            },
            folder_name: "Team files",
          }
        : { kind: "local" };
    if (command === "begin_attachment_upload")
      return (args as { explicit?: unknown })?.explicit ?? { kind: "local" };
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
  driveDefault = true;
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
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(([command]) => command === "upload_drive_file"),
  ).toBe(false);
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
    if (command === "attachment_upload_destination") return { kind: "local" };
    if (command === "begin_attachment_upload")
      return (args as { explicit?: unknown })?.explicit ?? { kind: "local" };
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
  const retry = within(
    screen.getByRole("listitem", { name: "bad.txt" }),
  ).getByRole("button", { name: "Retry" });
  await waitFor(() => expect(retry.hasAttribute("disabled")).toBe(false));
  fireEvent.click(retry);
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
    if (command === "attachment_upload_destination") return { kind: "local" };
    if (command === "begin_attachment_upload")
      return (args as { explicit?: unknown })?.explicit ?? { kind: "local" };
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
