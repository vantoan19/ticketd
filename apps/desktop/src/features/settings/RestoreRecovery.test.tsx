// @vitest-environment jsdom
import { useEffect, useRef, useState } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { DraftRecoveryProvider } from "@/lib/draft-recovery";
import {
  type DraftRecovery,
  useDraftRecovery,
  useDraftRecoveryGeneration,
  useDraftRecoveryNotices,
} from "@/lib/draft-recovery-context";
import { CreateTicketDialog } from "@/features/tickets/CreateTicketDialog";
import { RestoreDialog } from "./RestoreDialog";

const Notices = () => <main>{useDraftRecoveryNotices()}</main>;

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@uiw/react-codemirror", () => ({
  default: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (value: string) => void;
  }) => (
    <textarea
      aria-label="Description source"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));
window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
beforeAll(async () => {
  await import("@/features/markdown/MarkdownEditor");
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  localStorage.clear();
});

function RetainedNewTicket() {
  const generation = useDraftRecoveryGeneration();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={triggerRef} onClick={() => setOpen(true)}>
        Open New Ticket
      </button>
      <CreateTicketDialog
        key={generation}
        open={open}
        onOpenChange={setOpen}
        triggerRef={triggerRef}
        navigation={{ project: "all", plan: "" }}
        projects={[]}
        plans={[]}
        create={async () => "T-KQ1"}
      />
    </>
  );
}

function HoldRecoveryStore({
  capture,
}: {
  capture: (store: DraftRecovery) => void;
}) {
  const recovery = useDraftRecovery();
  const captured = useRef(false);
  useEffect(() => {
    if (captured.current) return;
    captured.current = true;
    capture(recovery);
  }, [capture, recovery]);
  return null;
}

function Editor() {
  const recovery = useDraftRecovery();
  const [result, setResult] = useState("");
  return (
    <>
      <button
        onClick={() => {
          void recovery.put("qa", { body: "new draft" }, []).then(
            () => setResult("Protected"),
            (reason: unknown) => setResult(String(reason)),
          );
        }}
      >
        Save after restore
      </button>
      <p>{result}</p>
    </>
  );
}

test.each([false, true])(
  "restoring reloads draft revisions and cutover state (initial pending: %s)",
  async (initialPending) => {
    let record = {
      owner: "qa",
      kind: "draft",
      revision: 9,
      payload: { body: "before" },
      markdown: [],
    };
    const summary = {
      tickets: 0,
      documents: 0,
      activities: 0,
      evidence: 0,
      projects: 0,
      plans: 0,
      last_change: null,
    };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "draft_retentions") return [record];
      if (command === "draft_cutover_pending")
        return record.revision < 9 ? !initialPending : initialPending;
      if (command === "inspect_backup")
        return {
          path: "backup.sqlite3",
          current: summary,
          check: { status: "valid", format_version: 55, summary },
        };
      if (command === "restore_workspace") {
        record = { ...record, revision: 2, payload: { body: "restored" } };
        return { safety_path: "safety.sqlite3" };
      }
      if (command === "retain_draft") {
        const draft = (args as { draft: typeof record }).draft;
        if (draft.revision !== record.revision)
          throw new Error("Recovery revision conflict");
        record = { ...draft, revision: draft.revision + 1 };
        return record;
      }
      throw new Error(`Unexpected ${command}`);
    });
    render(
      <DraftRecoveryProvider>
        <Notices />
        <Editor />
        <RestoreDialog
          path="backup.sqlite3"
          onClose={() => {}}
          onRestored={async () => {}}
        />
      </DraftRecoveryProvider>,
    );
    await screen.findByText("Backup checked.");
    fireEvent.click(
      screen.getByRole("button", { name: "Replace workspace with backup" }),
    );
    await screen.findByText("Workspace restored.");
    expect(
      Boolean(
        screen.queryByRole("button", {
          name: "All desktop profiles reviewed",
          hidden: true,
        }),
      ),
    ).toBe(!initialPending);
    fireEvent.click(
      screen.getByRole("button", { name: "Save after restore", hidden: true }),
    );
    await screen.findByText("Protected");
    expect(record.revision).toBe(3);
    expect(record.payload).toEqual({ body: "new draft" });
    expect(
      screen.queryByText(/Could not protect recoverable drafts/),
    ).toBeNull();
  },
);

test("restoring remounts a retained New Ticket draft from the backup", async () => {
  let record = {
    owner: "new-ticket",
    kind: "draft",
    revision: 9,
    payload: {
      title: "Old workspace draft",
      body: "old description",
      status: "Todo",
      project: "",
      plan: "",
      tags: [],
      restored: true,
    },
    markdown: ["old description"],
  };
  const records = new Map([[record.owner, record]]);
  const summary = {
    tickets: 0,
    documents: 0,
    activities: 0,
    evidence: 0,
    projects: 0,
    plans: 0,
    last_change: null,
  };
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "draft_retentions") return [...records.values()];
    if (command === "draft_cutover_pending") return false;
    if (command === "search_tags") return [];
    if (command === "inspect_backup")
      return {
        path: "backup.sqlite3",
        current: summary,
        check: { status: "valid", format_version: 55, summary },
      };
    if (command === "restore_workspace") {
      record = {
        ...record,
        revision: 2,
        payload: {
          title: "Backup draft",
          body: "backup description",
          status: "In Progress",
          project: "",
          plan: "",
          tags: [],
          restored: true,
        },
        markdown: ["backup description"],
      };
      records.set(record.owner, record);
      return { safety_path: "safety.sqlite3" };
    }
    if (command === "retain_draft") {
      const draft = (args as { draft: typeof record }).draft;
      const previous = records.get(draft.owner);
      if (draft.revision !== (previous?.revision ?? 0))
        throw new Error("Recovery revision conflict");
      const saved = { ...draft, revision: draft.revision + 1 };
      records.set(saved.owner, saved);
      if (saved.owner === record.owner) record = saved;
      return saved;
    }
    throw new Error(`Unexpected ${command}`);
  });
  render(
    <DraftRecoveryProvider>
      <RetainedNewTicket />
      <RestoreDialog
        path="backup.sqlite3"
        onClose={() => {}}
        onRestored={async () => {}}
      />
    </DraftRecoveryProvider>,
  );
  await screen.findByText("Backup checked.");
  fireEvent.click(
    screen.getByRole("button", { name: "Replace workspace with backup" }),
  );
  await screen.findByText("Workspace restored.");
  fireEvent.click(
    screen.getByRole("button", { name: "Open New Ticket", hidden: true }),
  );
  const title = await screen.findByRole("textbox", { name: "Title" });
  expect(title).toHaveProperty("value", "Backup draft");
  fireEvent.change(title, { target: { value: "Edited after restore" } });
  await waitFor(() =>
    expect(record.payload).toEqual({
      title: "Edited after restore",
      body: "backup description",
      status: "In Progress",
      project: "",
      plan: "",
      tags: [],
      restored: true,
    }),
  );
});

test("the replaced store rejects stale undo cleanup and flush without touching the restored record", async () => {
  let record = {
    owner: "undo:history",
    kind: "undo",
    revision: 9,
    payload: null as unknown,
    markdown: ["old description"],
  };
  const records = new Map([[record.owner, record]]);
  const summary = {
    tickets: 0,
    documents: 0,
    activities: 0,
    evidence: 0,
    projects: 0,
    plans: 0,
    last_change: null,
  };
  let staleStore: DraftRecovery | null = null;
  const capture = (store: DraftRecovery) => {
    staleStore ??= store;
  };
  let retainCalls = 0;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "draft_retentions") return [...records.values()];
    if (command === "draft_cutover_pending") return false;
    if (command === "inspect_backup")
      return {
        path: "backup.sqlite3",
        current: summary,
        check: { status: "valid", format_version: 55, summary },
      };
    if (command === "restore_workspace") {
      record = {
        ...record,
        revision: 2,
        markdown: ["backup description"],
      };
      records.set(record.owner, record);
      return { safety_path: "safety.sqlite3" };
    }
    if (command === "retain_draft") {
      retainCalls += 1;
      const draft = (args as { draft: typeof record }).draft;
      const previous = records.get(draft.owner);
      if (draft.revision !== (previous?.revision ?? 0))
        throw new Error("Recovery revision conflict");
      const saved = { ...draft, revision: draft.revision + 1 };
      records.set(saved.owner, saved);
      if (saved.owner === record.owner) record = saved;
      return saved;
    }
    throw new Error(`Unexpected ${command}`);
  });
  render(
    <DraftRecoveryProvider>
      <HoldRecoveryStore capture={capture} />
      <RestoreDialog
        path="backup.sqlite3"
        onClose={() => {}}
        onRestored={async () => {}}
      />
    </DraftRecoveryProvider>,
  );
  await screen.findByText("Backup checked.");
  await waitFor(() => expect(staleStore).not.toBeNull());
  fireEvent.click(
    screen.getByRole("button", { name: "Replace workspace with backup" }),
  );
  await screen.findByText("Workspace restored.");
  const retainsBeforeStaleCleanup = retainCalls;
  await expect(
    staleStore!.put("undo:history", null, [], "undo"),
  ).rejects.toThrow("Draft recovery store is no longer writable");
  await expect(staleStore!.flush()).rejects.toThrow(
    "Draft recovery store is no longer writable",
  );
  expect(retainCalls).toBe(retainsBeforeStaleCleanup);
  expect(records.get("undo:history")).toMatchObject({
    revision: 2,
    markdown: ["backup description"],
  });
  expect(screen.queryByText(/Could not protect recoverable drafts/)).toBeNull();
});

test.each(["draft_retentions", "draft_cutover_pending"] as const)(
  "a failed post-restore %s load leaves the previous recovery store blocked",
  async (failedCommand) => {
    let record = {
      owner: "undo:history",
      kind: "undo",
      revision: 9,
      payload: null as unknown,
      markdown: ["old description"],
    };
    const records = new Map([[record.owner, record]]);
    const summary = {
      tickets: 0,
      documents: 0,
      activities: 0,
      evidence: 0,
      projects: 0,
      plans: 0,
      last_change: null,
    };
    let listCalls = 0;
    let cutoverCalls = 0;
    let oldStore: DraftRecovery | null = null;
    const capture = (store: DraftRecovery) => {
      oldStore ??= store;
    };
    let retainCalls = 0;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "draft_retentions") {
        listCalls += 1;
        if (failedCommand === command && listCalls > 1)
          throw new Error("restored recovery rows unavailable");
        return [...records.values()];
      }
      if (command === "draft_cutover_pending") {
        cutoverCalls += 1;
        if (failedCommand === command && cutoverCalls > 1)
          throw new Error("restored cutover state unavailable");
        return false;
      }
      if (command === "inspect_backup")
        return {
          path: "backup.sqlite3",
          current: summary,
          check: { status: "valid", format_version: 55, summary },
        };
      if (command === "restore_workspace") {
        record = { ...record, revision: 2, markdown: ["backup description"] };
        records.set(record.owner, record);
        return { safety_path: "safety.sqlite3" };
      }
      if (command === "retain_draft") {
        retainCalls += 1;
        const draft = (args as { draft: typeof record }).draft;
        const previous = records.get(draft.owner);
        if (draft.revision !== (previous?.revision ?? 0))
          throw new Error("Recovery revision conflict");
        const saved = { ...draft, revision: draft.revision + 1 };
        records.set(saved.owner, saved);
        if (saved.owner === record.owner) record = saved;
        return saved;
      }
      throw new Error(`Unexpected ${command}`);
    });
    render(
      <DraftRecoveryProvider>
        <HoldRecoveryStore capture={capture} />
        <RestoreDialog
          path="backup.sqlite3"
          onClose={() => {}}
          onRestored={async () => {}}
        />
      </DraftRecoveryProvider>,
    );
    await screen.findByText("Backup checked.");
    await waitFor(() => expect(oldStore).not.toBeNull());
    fireEvent.click(
      screen.getByRole("button", { name: "Replace workspace with backup" }),
    );
    await screen.findByText(
      /The restore finished, but open views could not reload/,
    );
    const retainsAfterRestore = retainCalls;
    await expect(
      oldStore!.put("undo:history", null, [], "undo"),
    ).rejects.toThrow("Draft recovery store is no longer writable");
    await expect(oldStore!.flush()).rejects.toThrow(
      "Draft recovery store is no longer writable",
    );
    expect(retainCalls).toBe(retainsAfterRestore);
    expect(record.revision).toBe(2);
    expect(record.markdown).toEqual(["backup description"]);
    expect(
      screen.getByText(/The restore finished, but open views could not reload/)
        .textContent,
    ).toContain("Restart ticketd to see the restored data.");
    expect(
      screen.queryByText(/Could not protect recoverable drafts/),
    ).toBeNull();
  },
);
