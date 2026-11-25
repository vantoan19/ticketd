import { describe, expect, it, vi } from "vitest";
import { ChatError, type ChatChange } from "@/features/chats/client";
import {
  createHostChatClient,
  type HostBridge,
} from "@/features/chats/host-client";

const chat = {
  id: "c1",
  title: "Plan the release",
  harness: { id: "codex", name: "Codex" },
  folder: {
    path: "/work/app",
    name: "app",
    managed: false,
    missing: false,
    shared_with: [],
  },
  retention: "active",
  activity: "working",
  steering: { available: false },
  links: [],
  queue: [],
  queue_paused: false,
  unseen: false,
  muted: false,
  has_composer: true,
};
const response = (text: string) => ({
  id: "m1",
  at: "",
  kind: "response",
  text,
  state: "streaming",
});

/** A backend that answers from a table and lets the test push feed messages and events. */
function stubBridge(replies: Record<string, unknown> = {}) {
  let stored = false;
  const channels: ((message: unknown) => void)[] = [];
  const events = new Map<string, (payload: unknown) => void>();
  const invoke = vi.fn(async (command: string) => {
    const reply = replies[command];
    if (
      reply instanceof Error ||
      (reply && typeof reply === "object" && "code" in reply)
    )
      throw reply;
    return reply;
  });
  const bridge: HostBridge = {
    invoke,
    listen: async (event, handler) => {
      events.set(event, handler);
      return () => events.delete(event);
    },
    channel: (onMessage) => channels.push(onMessage),
    pickFolder: async () => null,
    saveFile: async () => null,
    stored: {
      get: () => stored,
      set: (value) => {
        stored = value;
        return true;
      },
    },
  };
  return {
    bridge,
    invoke,
    events,
    /** Sends on the feed of the nth `chat_open`. */
    push: (message: unknown, feed = 0) => channels[feed]?.(message),
    stored: () => stored,
  };
}

const opened = (subscription = 7) => ({
  chat_open: { subscription, snapshot: { chat, items: [], cursor: 0 } },
});

describe("the desktop Chat client", () => {
  it("delivers changes that arrived before the view subscribed, in order", async () => {
    const stub = stubBridge(opened());
    const client = createHostChatClient(stub.bridge);
    const snapshot = await client.openChat("c1");
    stub.push({ seq: 1, kind: "item", item: response("Hel") });
    const seen: ChatChange[] = [];

    const stop = client.subscribe("c1", snapshot.cursor, (c) => seen.push(c));
    stub.push({ seq: 2, kind: "text", item_id: "m1", text: "lo" });

    expect(seen.map((change) => change.seq)).toEqual([1, 2]);
    stop();
    expect(stub.invoke).toHaveBeenLastCalledWith("chat_close", {
      subscription: 7,
    });
    stub.push({ seq: 3, kind: "text", item_id: "m1", text: "!" });
    expect(seen).toHaveLength(2);
  });

  it("passes on an update's changes, sent together, one by one in order", async () => {
    const stub = stubBridge(opened());
    const client = createHostChatClient(stub.bridge);
    const snapshot = await client.openChat("c1");
    stub.push([{ seq: 1, kind: "item", item: response("Hel") }]);
    const seen: ChatChange[] = [];
    client.subscribe("c1", snapshot.cursor, (change) => seen.push(change));

    stub.push([
      { seq: 2, kind: "text", item_id: "m1", text: "lo" },
      { seq: 3, kind: "chat", chat },
    ]);

    expect(seen.map((change) => [change.seq, change.kind])).toEqual([
      [1, "item"],
      [2, "text"],
      [3, "chat"],
    ]);
  });

  it("turns a change it cannot read into a resync instead of passing it on", async () => {
    const stub = stubBridge(opened());
    const client = createHostChatClient(stub.bridge);
    const snapshot = await client.openChat("c1");
    const seen: ChatChange[] = [];
    client.subscribe("c1", snapshot.cursor, (change) => seen.push(change));
    stub.push({ seq: 1, kind: "item", item: response("Hi") });

    stub.push({ seq: 2, kind: "item", item: { kind: "codex/agentMessage" } });
    stub.push({ seq: 3, kind: "text", item_id: "m1", text: "late" });

    expect(seen.map((change) => [change.seq, change.kind])).toEqual([
      [1, "item"],
      [2, "resync"],
    ]);
    expect(stub.invoke).toHaveBeenLastCalledWith("chat_close", {
      subscription: 7,
    });
  });

  it("tells a subscriber with no feed behind its snapshot to open the Chat again", async () => {
    const client = createHostChatClient(stubBridge().bridge);
    const seen: ChatChange[] = [];

    client.subscribe("c1", 4, (change) => seen.push(change));
    await Promise.resolve();

    expect(seen).toEqual([{ seq: 5, kind: "resync" }]);
  });

  it("abandons an open nobody subscribed to when the Chat is opened again", async () => {
    const stub = stubBridge(opened());
    const client = createHostChatClient(stub.bridge);
    await client.openChat("c1");

    const snapshot = await client.openChat("c1");
    const seen: ChatChange[] = [];
    client.subscribe("c1", snapshot.cursor, (change) => seen.push(change));
    stub.push({ seq: 1, kind: "item", item: response("old") }, 0);
    stub.push({ seq: 1, kind: "item", item: response("new") }, 1);

    expect(stub.invoke).toHaveBeenCalledWith("chat_close", { subscription: 7 });
    expect(seen).toHaveLength(1);
  });

  it("rejects backend values that do not match the contract", async () => {
    const stub = stubBridge({
      chat_list: [{ id: "c1", title: "No activity field" }],
      chat_open: {
        subscription: 1,
        snapshot: { chat, items: [{}], cursor: 0 },
      },
      chat_overview: { needs_you: -1, unread: 0, app_icon: 0, working: 0 },
    });
    const client = createHostChatClient(stub.bridge);

    await expect(client.listChats("active")).rejects.toThrow();
    await expect(client.openChat("c1")).rejects.toThrow();
    await expect(client.overview()).rejects.toThrow();
  });

  it("reports a refused command by its code and the backend's own words", async () => {
    const stub = stubBridge({
      chat_answer: {
        code: "stale",
        message: "this request is no longer waiting for an answer",
      },
      chat_stop: new Error("the workspace is locked"),
    });
    const client = createHostChatClient(stub.bridge);

    const stale = client.answer("c1", "r1", { option_id: "allow" });
    await expect(stale).rejects.toEqual(
      new ChatError("stale", "this request is no longer waiting for an answer"),
    );
    await expect(stale).rejects.toHaveProperty("code", "stale");
    await expect(client.stop("c1")).rejects.toHaveProperty("code", "failed");
    expect(stub.invoke).toHaveBeenCalledWith("chat_answer", {
      chatId: "c1",
      requestId: "r1",
      answer: { option_id: "allow" },
    });
  });

  it("keeps the Experimental choice and tells the backend, which starts with Chat off", async () => {
    const stub = stubBridge();
    const client = createHostChatClient(stub.bridge);
    expect(await client.getEnabled()).toBe(false);
    expect(stub.invoke).not.toHaveBeenCalled();

    await client.setEnabled(true);

    expect(stub.stored()).toBe(true);
    expect(await createHostChatClient(stub.bridge).getEnabled()).toBe(true);
    expect(stub.invoke).toHaveBeenLastCalledWith("chat_set_enabled", {
      enabled: true,
    });
  });

  it("does not leave Chat switched on when the backend could not start it", async () => {
    const stub = stubBridge({
      chat_set_enabled: { code: "failed", message: "workspace unavailable" },
    });
    const client = createHostChatClient(stub.bridge);

    await expect(client.setEnabled(true)).rejects.toThrow(
      "workspace unavailable",
    );

    expect(stub.stored()).toBe(false);
  });

  it("passes on overview and quit events only when they are well formed", async () => {
    const stub = stubBridge();
    const client = createHostChatClient(stub.bridge);
    const overviews: unknown[] = [];
    const quits: unknown[] = [];
    const stop = client.subscribeOverview((value) => overviews.push(value));
    client.onQuitRequested((stopping) => quits.push(stopping));
    await Promise.resolve();

    const counts = { needs_you: 1, unread: 0, app_icon: 1, working: 2 };
    stub.events.get("chat-overview")?.(counts);
    stub.events.get("chat-overview")?.({ needs_you: "many" });
    stub.events.get("chat-quit-requested")?.({ chats: 2, runs: 1 });
    stub.events.get("chat-quit-requested")?.(2);
    stop();
    await Promise.resolve();

    expect(overviews).toEqual([counts]);
    expect(quits).toEqual([{ chats: 2, runs: 1 }]);
    expect(stub.events.has("chat-overview")).toBe(false);
  });

  it("opens the Chat a failed first send left behind instead of losing it", async () => {
    const input = {
      command_id: "0b9a1c4e-0000-4000-8000-000000000001",
      harness_id: "codex",
      folder: null,
      links: [{ kind: "project" as const, id: "p1" }],
      message: "first",
    };
    const created = { chat_id: "c1", send_error: "storage failed" };
    const client = createHostChatClient(
      stubBridge({ chat_create: created }).bridge,
    );
    expect(await client.createChat(input)).toEqual(created);

    const old = createHostChatClient(stubBridge({ chat_create: "c1" }).bridge);
    await expect(old.createChat(input)).rejects.toThrow();
  });

  it("CH-47: finds a typed reference's ticket first, once, and never a trashed one", async () => {
    const fv1 = {
      kind: "ticket",
      id: "t1",
      reference: "T-FV1",
      title: "Board columns",
      status: "Todo",
    };
    const other = { kind: "document", id: "d1", title: "T-FV1 notes" };
    // What show_ticket replies, trimmed to what a link needs.
    const ticket = {
      id: "t1",
      reference: "T-FV1",
      title: "Board columns",
      status: "Todo",
      trashed: false,
    };
    const stub = stubBridge({
      chat_search_records: [other, fv1],
      show_ticket: ticket,
    });
    const client = createHostChatClient(stub.bridge);
    expect(await client.searchRecords(" t-fv1 ")).toEqual([fv1, other]);
    expect(stub.invoke).toHaveBeenCalledWith("show_ticket", {
      reference: "T-FV1",
    });

    const trashed = stubBridge({
      chat_search_records: [],
      show_ticket: { ...ticket, trashed: true },
    });
    expect(
      await createHostChatClient(trashed.bridge).searchRecords("T-FV1"),
    ).toEqual([]);

    // Not a reference: no lookup; an unknown reference is no failure.
    const plain = stubBridge({ chat_search_records: [] });
    await createHostChatClient(plain.bridge).searchRecords("board");
    expect(plain.invoke).not.toHaveBeenCalledWith(
      "show_ticket",
      expect.anything(),
    );
    const missing = stubBridge({
      chat_search_records: [],
      show_ticket: new Error("No ticket T-ZZ9"),
    });
    expect(
      await createHostChatClient(missing.bridge).searchRecords("T-ZZ9"),
    ).toEqual([]);
  });
});
