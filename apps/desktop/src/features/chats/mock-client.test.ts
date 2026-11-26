import { expect, test } from "vitest";
import type {
  ChatChange,
  RecordChange,
  TranscriptItem,
} from "@/features/chats/client";
import {
  chatState,
  createMockChatClient,
  HARNESS_OPTIONS,
} from "@/features/chats/mock-client";

const at = "2026-11-10T10:00:00Z";
const approval: TranscriptItem = {
  id: "req-1",
  at,
  kind: "request",
  request: "approval",
  title: "Codex wants to run",
  subject: "npm install",
  options: [{ id: "once", label: "Allow once" }],
  free_text: false,
  state: "pending",
};
const working = (over = {}) =>
  createMockChatClient({
    chats: [
      {
        chat: chatState({
          id: "c1",
          title: "Limiter",
          activity: "working",
          ...over,
        }),
        items: [approval],
      },
    ],
  });

test.each(["claude-code", "antigravity"])(
  "a fixture can create a Chat with an attachment using %s",
  async (harness_id) => {
    const client = createMockChatClient({
      harnesses: [{ id: harness_id, name: harness_id, status: "ready" }],
    });
    const { chat_id } = await client.createChat({
      command_id: "first-message",
      harness_id,
      folder: null,
      links: [],
      message: "",
      attachments: [
        { name: "notes.txt", dataUrl: "data:text/plain;base64,bm90ZXM=" },
      ],
    });
    expect((await client.openChat(chat_id)).items).toContainEqual(
      expect.objectContaining({
        kind: "user",
        attachments: [expect.objectContaining({ name: "notes.txt" })],
      }),
    );
  },
);

test("an unsupported fixture harness still refuses an attachment", async () => {
  const client = createMockChatClient({
    harnesses: [
      { id: "fixture-harness", name: "Fixture Harness", status: "ready" },
    ],
  });
  await expect(
    client.createChat({
      command_id: "first-message",
      harness_id: "fixture-harness",
      folder: null,
      links: [],
      message: "",
      attachments: [
        { name: "notes.txt", dataUrl: "data:text/plain;base64,bm90ZXM=" },
      ],
    }),
  ).rejects.toThrow("can't take Chat attachments");
});

test("a request takes one answer; a second is refused as stale", async () => {
  const client = working({ activity: "waiting" });
  await client.answer("c1", "req-1", { option_id: "once" });
  await expect(
    client.answer("c1", "req-1", { option_id: "once" }),
  ).rejects.toMatchObject({ code: "stale" });
  const { items } = await client.openChat("c1");
  expect(items[0]).toMatchObject({
    state: "answered",
    outcome: 'You chose "Allow once"',
  });
});

test("Stop pauses the queue, keeps what was queued and expires the live request", async () => {
  const client = working();
  await client.queue("c1", "then add tests");
  await client.stop("c1");
  const { chat, items } = await client.openChat("c1");
  expect(chat).toMatchObject({
    activity: "interrupted",
    queue_paused: true,
    queue: [{ text: "then add tests" }],
  });
  expect(items[0]).toMatchObject({ state: "expired" });
  expect(items.at(-1)).toMatchObject({ kind: "marker", reason: "stopped" });
});

test("sending mid-turn is queued when the harness cannot be steered", async () => {
  const client = working({ steering: { available: false } });
  await client.send("c1", "also update the docs");
  const { chat, items } = await client.openChat("c1");
  expect(chat.queue).toEqual([
    { id: expect.any(String), text: "also update the docs" },
  ]);
  expect(items.some((item) => item.kind === "user")).toBe(false);
});

const note = {
  name: "notes.txt",
  dataUrl: "data:text/plain;base64,bm90ZXM=",
};

test("a create command replays only the same caption, attachments, and Chat settings", async () => {
  const client = createMockChatClient();
  const input = {
    command_id: "first-message",
    harness_id: "claude-code",
    folder: null,
    links: [],
    message: "Read the notes",
    attachments: [{ ...note }],
  };
  const original = await client.createChat(input);
  await expect(
    client.createChat({ ...input, attachments: [{ ...note }] }),
  ).resolves.toEqual(original);
  const changes: Partial<Parameters<typeof client.createChat>[0]>[] = [
    { message: "Different caption" },
    { attachments: [{ ...note, name: "other.txt" }] },
    { attachments: [{ ...note, dataUrl: "data:text/plain;base64,ZXh0cmE=" }] },
    { attachments: [] },
    { harness_id: "codex" },
    { folder: "/elsewhere" },
    { links: [{ kind: "document", id: "doc" }] },
    { model: "sonnet" },
    { effort: "high" },
    { permission: "plan" },
  ];
  for (const change of changes)
    await expect(client.createChat({ ...input, ...change })).rejects.toThrow(
      "Request ID was already used for different content",
    );
  expect(await client.listChats("active")).toHaveLength(1);
});

async function queuedNote(client: ReturnType<typeof createMockChatClient>) {
  await client.queue("c1", "Read the notes", [], [{ ...note }]);
  const queued = (await client.openChat("c1")).chat.queue[0];
  if (!queued) throw new Error("The queued input is missing.");
  return queued;
}

const seededNote = {
  id: "queued-1",
  text: "Read the notes",
  attachments: [{ id: "notes", name: note.name, media_type: "text/plain" }],
};

test.each([false, true])(
  "creating a Chat preserves seeded IDs and queued bytes (failed first attempt: %s)",
  async (firstAttemptFails) => {
    const client = createMockChatClient({
      chats: [
        {
          chat: chatState({
            id: "chat-1",
            title: "Seeded Chat",
            queue: [seededNote],
            queue_paused: true,
          }),
          queuedFiles: { [seededNote.id]: [note] },
        },
      ],
    });
    const seed = await client.openChat("chat-1");
    const input = {
      command_id: "new-chat",
      harness_id: "codex",
      folder: null,
      links: [],
      message: "A new Chat",
      attachments: [note],
    };
    if (firstAttemptFails) {
      await expect(
        client.createChat({
          ...input,
          attachments: [{ ...note, dataUrl: null as unknown as string }],
        }),
      ).rejects.toThrow();
      expect(await client.openChat("chat-1")).toEqual(seed);
      expect(await client.listChats("active")).toHaveLength(1);
    }
    const { chat_id } = await client.createChat(input);
    expect(chat_id).not.toBe("chat-1");
    expect(await client.openChat(chat_id)).toMatchObject({
      items: [
        {
          kind: "user",
          text: input.message,
          attachments: [{ name: note.name }],
        },
      ],
    });
    expect(await client.openChat("chat-1")).toEqual(seed);
    await expect(client.editQueued("chat-1", seededNote.id)).resolves.toEqual({
      text: seededNote.text,
      attachments: [note],
    });
  },
);

test.each(["Send now", "Resume"])(
  "a seeded queued attachment keeps its snapshot through Edit and %s",
  async (action) => {
    const file = { ...note };
    const client = createMockChatClient({
      chats: [
        {
          chat: chatState({
            id: "c1",
            title: "Limiter",
            queue: [seededNote],
            queue_paused: true,
          }),
          queuedFiles: { [seededNote.id]: [file] },
        },
      ],
    });
    file.name = "Changed seed.txt";
    await expect(client.editQueued("c1", seededNote.id)).resolves.toEqual({
      text: seededNote.text,
      attachments: [note],
    });

    if (action === "Send now") await client.sendQueuedNow("c1", seededNote.id);
    else await client.resumeQueue("c1");
    const { chat, items } = await client.openChat("c1");
    expect(chat.queue).toEqual([]);
    expect(items).toMatchObject([
      {
        kind: "user",
        text: seededNote.text,
        attachments: [{ name: note.name }],
      },
    ]);
  },
);

test("a seeded queued attachment with missing bytes is never consumed", async () => {
  const client = createMockChatClient({
    chats: [
      {
        chat: chatState({
          id: "c1",
          title: "Limiter",
          queue: [seededNote],
          queue_paused: true,
        }),
      },
    ],
  });
  for (const operation of [
    () => client.editQueued("c1", seededNote.id),
    () => client.sendQueuedNow("c1", seededNote.id),
    () => client.resumeQueue("c1"),
  ])
    await expect(operation()).rejects.toThrow(
      "Missing matching attachment snapshots",
    );
  const { chat, items } = await client.openChat("c1");
  expect(chat).toMatchObject({ queue: [seededNote], queue_paused: true });
  expect(items).toEqual([]);
});

const ticket = {
  kind: "ticket" as const,
  id: "ticket",
  reference: "T-14",
  title: "Fix login",
  status: "Todo",
};

test("a rejected queue edit leaves the Chat and its subscribers without partial links", async () => {
  const client = createMockChatClient({
    records: [ticket],
    chats: [{ chat: chatState({ id: "c1", title: "Limiter" }) }],
  });
  const queued = await queuedNote(client);
  await client.confirmQueueEdit("c1", queued.id, "hold-edit");
  const before = await client.openChat("c1");
  const changes: ChatChange[] = [];
  const unlisten = client.subscribe("c1", before.cursor, (change) =>
    changes.push(change),
  );
  const command = { commandId: "save-edit", messageIds: [queued.id] };
  await expect(
    client.queue(
      "c1",
      "Edited",
      [ticket, { kind: "document", id: "missing" }],
      [note],
      command,
    ),
  ).rejects.toThrow("The record was not found.");
  // Exercise an attachment failure after the valid link has been resolved.
  await expect(
    client.send(
      "c1",
      "Edited",
      [ticket],
      [{ ...note, dataUrl: null as unknown as string }],
      command,
    ),
  ).rejects.toThrow();
  unlisten();
  expect(changes).toEqual([]);
  expect(await client.openChat("c1")).toEqual(before);
  await expect(
    client.checkQueueEdits("c1", [command.commandId], []),
  ).resolves.toEqual({
    saved: [],
    removed: [],
  });
});

test("a linked edit commits its input, queue replacement, and receipt before a subscriber trashes the Chat", async () => {
  const guide = { kind: "document" as const, id: "guide", title: "Guide" };
  const links = [ticket, guide];
  const client = createMockChatClient({
    records: links,
    chats: [{ chat: chatState({ id: "c1", title: "Limiter" }) }],
  });
  const queued = await queuedNote(client);
  await client.confirmQueueEdit("c1", queued.id, "hold-edit");
  const { cursor } = await client.openChat("c1");
  const command = { commandId: "save-edit", messageIds: [queued.id] };
  const changes: ChatChange[] = [];
  let observed:
    | {
        snapshot: ReturnType<typeof client.openChat>;
        edits: ReturnType<typeof client.checkQueueEdits>;
      }
    | undefined;
  let trash: ReturnType<typeof client.trash> | undefined;
  const unlisten = client.subscribe("c1", cursor, (change) => {
    if (observed || change.kind !== "chat" || !change.chat.links.length) return;
    observed = {
      snapshot: client.openChat("c1"),
      edits: client.checkQueueEdits("c1", [command.commandId], [queued.id]),
    };
    trash = client.trash("c1");
  });
  const unlistenObserver = client.subscribe("c1", cursor, (change) =>
    changes.push(change),
  );
  await client.send("c1", "Edited caption", links, [note], command);
  await trash;
  unlisten();
  unlistenObserver();
  expect(await observed?.snapshot).toMatchObject({
    chat: { activity: "working", links, queue: [] },
    items: [{ kind: "user", text: "Edited caption" }],
  });
  expect(await observed?.edits).toEqual({
    saved: [command.commandId],
    removed: [queued.id],
  });
  expect(changes.map((change) => change.seq)).toEqual(
    changes.map((_, index) => cursor + index + 1),
  );
  expect(changes.find((change) => change.kind === "chat")).toMatchObject({
    chat: { activity: "working", links, queue: [] },
  });
  expect(await client.openChat("c1")).toMatchObject({
    chat: { retention: "trashed", links, queue: [] },
    items: [
      {
        kind: "user",
        text: "Edited caption",
        attachments: [{ name: note.name }],
      },
      { kind: "marker", reason: "stopped" },
    ],
  });
  await expect(
    client.send(
      "c1",
      "Edited caption",
      [ticket, guide, ticket],
      [note],
      command,
    ),
  ).resolves.toBeUndefined();
  await expect(
    client.send("c1", "Edited caption", [guide, ticket], [note], command),
  ).rejects.toThrow("Request ID was already used for different content");
});

test("a subscriber cannot reentrantly Send now the same queued message", async () => {
  const client = working();
  const queued = await queuedNote(client);
  const { cursor } = await client.openChat("c1");
  let attempted = false;
  let nested: Promise<unknown> | undefined;
  const unlisten = client.subscribe("c1", cursor, (change) => {
    if (attempted || change.kind !== "item" || change.item.kind !== "user")
      return;
    attempted = true;
    nested = client
      .sendQueuedNow("c1", queued.id)
      .catch((error: unknown) => error);
  });
  await client.sendQueuedNow("c1", queued.id);
  unlisten();
  expect(await nested).toMatchObject({ code: "stale" });
  const { chat, items } = await client.openChat("c1");
  expect(chat.queue).toEqual([]);
  expect(items.filter((item) => item.kind === "user")).toMatchObject([
    { text: queued.text, attachments: [{ name: note.name }] },
  ]);
});

test("Send now rejects a fresh queue-edit transfer and keeps the result of an earlier transfer", async () => {
  const client = working();
  const earlier = await queuedNote(client);
  await client.confirmQueueEdit("c1", earlier.id, "earlier-transfer");
  await client.removeQueued("c1", earlier.id);
  const queued = await queuedNote(client);
  await client.editQueued("c1", queued.id);
  const { cursor } = await client.openChat("c1");
  let confirmation: Promise<boolean[]> | undefined;
  const unlisten = client.subscribe("c1", cursor, (change) => {
    if (change.kind !== "item" || change.item.kind !== "user") return;
    confirmation = Promise.all([
      client.confirmQueueEdit("c1", queued.id, "pending-transfer"),
      client.confirmQueueEdit("c1", earlier.id, "earlier-transfer"),
    ]);
  });
  await client.sendQueuedNow("c1", queued.id);
  unlisten();
  expect(await confirmation).toEqual([false, true]);
});

test("Resume preserves the paused queue and its attachment bytes in Trash", async () => {
  const client = createMockChatClient({
    chats: [
      {
        chat: chatState({
          id: "c1",
          title: "Limiter",
          queue: [seededNote, { id: "second", text: "Second message" }],
          queue_paused: true,
        }),
        queuedFiles: { [seededNote.id]: [note] },
      },
    ],
  });
  await client.trash("c1");
  const before = await client.openChat("c1");
  await expect(client.resumeQueue("c1")).rejects.toThrow(
    "This Chat is in Trash.",
  );
  expect(await client.openChat("c1")).toEqual(before);
  await client.restore("c1");
  await expect(client.editQueued("c1", seededNote.id)).resolves.toEqual({
    text: seededNote.text,
    attachments: [note],
  });
  await client.resumeQueue("c1");
  expect(await client.openChat("c1")).toMatchObject({
    chat: { queue_paused: false, queue: [{ id: "second" }] },
    items: [
      {
        kind: "user",
        text: seededNote.text,
        attachments: [{ name: note.name }],
      },
    ],
  });
});

test("Resume starts the first queued turn before a subscriber can send the second message", async () => {
  const client = createMockChatClient({
    chats: [
      {
        chat: chatState({
          id: "c1",
          title: "Limiter",
          queue: [seededNote, { id: "second", text: "Second message" }],
          queue_paused: true,
          steering: { available: false },
        }),
        queuedFiles: { [seededNote.id]: [note] },
      },
    ],
  });
  const { cursor } = await client.openChat("c1");
  let competing: Promise<unknown> | undefined;
  const unlisten = client.subscribe("c1", cursor, (change) => {
    if (competing || change.kind !== "chat" || change.chat.queue.length !== 1)
      return;
    competing = client
      .sendQueuedNow("c1", "second")
      .catch((error: unknown) => error);
  });
  await client.resumeQueue("c1");
  unlisten();
  expect(await competing).toMatchObject({
    message: "the Chat is working; try again when it has finished",
  });
  expect(await client.openChat("c1")).toMatchObject({
    chat: {
      activity: "working",
      queue_paused: false,
      queue: [{ id: "second" }],
    },
    items: [
      {
        kind: "user",
        text: seededNote.text,
        attachments: [{ name: note.name }],
      },
    ],
  });
});

test("concurrent retries save one queued edit and reject changed input for the same command", async () => {
  const client = working();
  const queued = await queuedNote(client);
  const edit = { commandId: "save-edit", messageIds: [queued.id] };
  await client.confirmQueueEdit("c1", queued.id, "hold-edit");

  const first = client.queue("c1", "Revised caption", [], [note], edit);
  const replay = client.queue("c1", "Revised caption", [], [{ ...note }], edit);
  await expect(
    client.queue("c1", "Different caption", [], [note], edit),
  ).rejects.toMatchObject({ code: "failed" });
  await Promise.all([first, replay]);

  const { chat } = await client.openChat("c1");
  expect(chat.queue).toEqual([
    {
      id: expect.any(String),
      text: "Revised caption",
      attachments: [
        { id: expect.any(String), name: note.name, media_type: "text/plain" },
      ],
    },
  ]);
  expect(chat.queue[0]?.id).not.toBe(queued.id);
  await expect(
    client.checkQueueEdits("c1", [edit.commandId], [queued.id]),
  ).resolves.toEqual({ saved: [edit.commandId], removed: [queued.id] });

  await client.send("c1", "Revised caption", [], [note], edit);
  await expect(
    client.queue(
      "c1",
      "Revised caption",
      [],
      [{ ...note, dataUrl: "data:text/plain;base64,ZXh0cmE=" }],
      edit,
    ),
  ).rejects.toMatchObject({ code: "failed" });
  expect(await client.openChat("c1")).toMatchObject({
    chat: { queue: chat.queue },
    items: [approval],
  });
});

test("a rejected queue edit leaves its command free for a later retry", async () => {
  const client = working();
  const queued = await queuedNote(client);
  const edit = { commandId: "save-edit", messageIds: [queued.id] };

  await expect(
    client.queue("c1", "Revised caption", [], [note], edit),
  ).rejects.toMatchObject({ code: "stale" });
  await expect(
    client.checkQueueEdits("c1", [edit.commandId], []),
  ).resolves.toEqual({ saved: [], removed: [] });
  await client.confirmQueueEdit("c1", queued.id, "hold-edit");
  await client.queue("c1", "Revised caption", [], [note], edit);
  expect((await client.openChat("c1")).chat.queue).toMatchObject([
    { text: "Revised caption" },
  ]);
});

test("queued files are independent of both the request and editor attachment objects", async () => {
  const client = working();
  const notes = { ...note };
  const files = [notes];
  await client.queue("c1", "Read the notes", [], files);
  const queued = (await client.openChat("c1")).chat.queue[0];
  if (!queued) throw new Error("The queued input is missing.");

  notes.name = "Changed request.txt";
  files.pop();
  const editor = await client.editQueued("c1", queued.id);
  expect(editor.attachments).toEqual([note]);
  const edited = editor.attachments.pop();
  if (!edited) throw new Error("The saved attachment is missing.");
  edited.dataUrl = "data:text/plain;base64,ZXh0cmE=";
  await expect(client.editQueued("c1", queued.id)).resolves.toEqual({
    text: "Read the notes",
    attachments: [note],
  });
});

test("Send now accepts the original input before concurrent Trash can stop it", async () => {
  const client = working();
  const queued = await queuedNote(client);
  await Promise.all([
    client.sendQueuedNow("c1", queued.id),
    client.trash("c1"),
  ]);
  const { chat, items } = await client.openChat("c1");
  expect(chat).toMatchObject({ retention: "trashed", queue: [] });
  expect(items.filter((item) => item.kind === "user")).toMatchObject([
    {
      text: "Read the notes",
      attachments: [{ name: note.name, media_type: "text/plain" }],
    },
  ]);
});

test("Send now refused in Trash keeps the queued text and attachment bytes after Restore", async () => {
  const client = working();
  const queued = await queuedNote(client);
  await client.trash("c1");
  await expect(client.sendQueuedNow("c1", queued.id)).rejects.toThrow(
    "This Chat is in Trash.",
  );
  await client.restore("c1");
  const { chat, items } = await client.openChat("c1");
  expect(chat.queue).toEqual([queued]);
  expect(items.filter((item) => item.kind === "user")).toEqual([]);
  await expect(client.editQueued("c1", queued.id)).resolves.toEqual({
    text: "Read the notes",
    attachments: [note],
  });
  await client.sendQueuedNow("c1", queued.id);
  expect((await client.openChat("c1")).chat.queue).toEqual([]);
});

test("trash stops the work and restore never restarts it", async () => {
  const client = working();
  await client.queue("c1", "next");
  await client.trash("c1");
  expect(await client.listChats("active")).toEqual([]);
  await client.restore("c1");
  const { chat, items } = await client.openChat("c1");
  expect(chat).toMatchObject({
    retention: "active",
    activity: "interrupted",
    queue: [{ text: "next" }],
  });
  expect(items.filter((item) => item.kind === "user")).toEqual([]);
});

test("a subscriber whose cursor is older than the kept log is told to resync", async () => {
  const client = createMockChatClient({
    logLimit: 2,
    chats: [{ chat: chatState({ id: "c1", title: "Limiter" }) }],
  });
  for (const text of ["a", "b", "c"])
    client.push("c1", {
      id: text,
      at,
      kind: "marker",
      reason: "note",
      message: text,
    });
  const seen: ChatChange[] = [];
  client.subscribe("c1", 0, (change) => seen.push(change));
  expect(seen).toEqual([{ seq: 3, kind: "resync" }]);
  const recent: ChatChange[] = [];
  client.subscribe("c1", 2, (change) => recent.push(change));
  expect(recent).toMatchObject([{ seq: 3, kind: "item" }]);
});

test("reconnecting the same callback replays each sequence once and retires the old subscription", async () => {
  const client = createMockChatClient({
    chats: [{ chat: chatState({ id: "c1", title: "Limiter" }) }],
  });
  const seen: number[] = [];
  let stopReconnected: (() => void) | undefined;
  const listener = (change: ChatChange) => {
    seen.push(change.seq);
    if (change.seq === 1) {
      stopOriginal();
      stopReconnected = client.subscribe("c1", change.seq, listener);
    }
    if (change.seq === 2) client.patch("c1", { muted: true });
  };
  const stopOriginal = client.subscribe("c1", 0, listener);
  await client.send("c1", "Start a turn");
  expect(seen).toEqual([1, 2, 3]);
  stopOriginal();
  client.patch("c1", { muted: false });
  expect(seen).toEqual([1, 2, 3, 4]);
  stopReconnected?.();
  client.patch("c1", { muted: true });
  expect(seen).toEqual([1, 2, 3, 4]);
});

test("a write made during initial replay reaches the subscriber after the backlog", () => {
  const client = working();
  client.patch("c1", { muted: true });
  client.patch("c1", { muted: false });
  const seen: number[] = [];
  const stop = client.subscribe("c1", 0, (change) => {
    seen.push(change.seq);
    if (change.seq === 1) client.patch("c1", { muted: true });
  });
  stop();
  expect(seen).toEqual([1, 2, 3]);
});

test("the overview counts Chats that need the person and Chats at work", async () => {
  const client = working({ activity: "waiting" });
  expect(await client.overview()).toEqual({
    needs_you: 1,
    unread: 0,
    app_icon: 1,
    working: 1,
  });
  const seen: unknown[] = [];
  client.subscribeOverview((overview) => seen.push(overview));
  await client.stop("c1");
  expect(seen.at(-1)).toEqual({
    needs_you: 0,
    unread: 0,
    app_icon: 0,
    working: 0,
  });
});

test("the count takes uncertain delivery and failures, not a sign-in step alone", async () => {
  const chat = (id: string, over: object) => ({
    chat: chatState({ id, title: id, ...over }),
  });
  const client = createMockChatClient({
    chats: [
      chat("uncertain", { problem: { kind: "uncertain_delivery" } }),
      chat("failed", { activity: "failed" }),
      chat("lost", { problem: { kind: "failed" } }),
      chat("install", {
        activity: "failed",
        problem: { kind: "not_installed" },
      }),
      chat("sign-in", { problem: { kind: "not_signed_in" } }),
      chat("idle", {}),
    ],
  });
  expect((await client.overview()).needs_you).toBe(4);
  const counted = (await client.listChats("active"))
    .filter((row) => row.needs_you)
    .map((row) => row.id);
  // An install failure that stopped a turn counts until seen (spec 21.3).
  expect(counted.sort()).toEqual(["failed", "install", "lost", "uncertain"]);
});

test("quitting stops working Chats and says why in their history", async () => {
  const client = working();
  let asked: unknown = null;
  client.onQuitRequested((stopping) => (asked = stopping));
  client.requestQuit();
  expect(asked).toEqual({ chats: 1, runs: 0 });
  await client.answerQuit(true);
  const { items } = await client.openChat("c1");
  expect(items.at(-1)).toMatchObject({ kind: "marker", reason: "quit" });
  expect(client.quit).toBe(true);
});

test("an idle row says the first sentence of its latest turn's records row, with the host's netted moves", async () => {
  const records = (
    id: string,
    turn: string,
    changes: RecordChange[],
    net?: RecordChange[],
  ) =>
    ({
      id,
      at,
      kind: "records",
      turn_id: turn,
      changes,
      net,
    }) as TranscriptItem;
  const moved: RecordChange = {
    kind: "status",
    reference: "T-12",
    title: "Demo",
    from: "Todo",
    to: "In review",
  };
  const posted: RecordChange = {
    kind: "update",
    reference: "T-12",
    excerpt: "Done",
  };
  const next: RecordChange = {
    kind: "update",
    reference: "T-13",
    excerpt: "Hi",
  };
  const client = createMockChatClient({
    chats: [
      {
        chat: chatState({ id: "c1", title: "One turn" }),
        items: [records("r1", "t1", [moved, posted])],
      },
      {
        chat: chatState({ id: "c3", title: "Moved twice" }),
        items: [
          records("r1", "t1", [
            { ...moved, from: "Todo", to: "In progress" },
            posted,
          ]),
          // The host nets the whole turn on its last call.
          records(
            "r2",
            "t1",
            [{ ...moved, from: "In progress" }],
            [moved, posted],
          ),
        ],
      },
      {
        chat: chatState({ id: "c2", title: "Two turns" }),
        items: [
          records("r1", "t1", [moved]),
          records("r2", "t2", [next, moved]),
        ],
      },
    ],
  });
  const rows = await client.listChats("active");
  const line = (id: string) => rows.find((row) => row.id === id)?.status.word;
  expect(line("c1")).toBe("Moved T-12 to In review");
  expect(line("c2")).toBe("Posted an update on T-13");
  // Todo -> In progress -> In review: the host's net list on the last call leads.
  expect(line("c3")).toBe("Moved T-12 to In review");
});

test("NAV-03: every permission mode says what it can touch, in one sentence", () => {
  for (const harness of HARNESS_OPTIONS) {
    for (const mode of harness.permission?.options ?? []) {
      expect(mode.description, `${harness.harness_id} ${mode.label}`).toMatch(
        /^[^.]+\.$/,
      );
    }
  }
});
