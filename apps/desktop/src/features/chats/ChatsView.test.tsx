// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
  ChatClientContext,
  type TranscriptItem,
} from "@/features/chats/client";
import { ChatProvider } from "@/features/chats/ChatProvider";
import { ChatsView } from "@/features/chats/ChatsView";
import {
  chatState,
  createMockChatClient,
  type MockChat,
} from "@/features/chats/mock-client";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

afterEach(cleanup);

const at = "2026-11-10T10:00:00Z";
const reply = (id: string, text: string): TranscriptItem => ({
  id,
  at,
  kind: "response",
  text,
  state: "complete",
});
const approval: TranscriptItem = {
  id: "req-1",
  at,
  kind: "request",
  request: "approval",
  title: "Codex wants to run a command",
  subject: "npm install @pagerduty/pdjs",
  options: [
    { id: "once", label: "Allow once" },
    { id: "session", label: "Allow for this session" },
    { id: "deny", label: "Deny" },
  ],
  free_text: false,
  state: "pending",
};

async function open(chats: MockChat[], title?: string) {
  const client = createMockChatClient({
    enabled: true,
    chats,
    records: [
      {
        kind: "ticket",
        id: "t14",
        reference: "T-14",
        title: "Show the remaining wait time",
        status: "Todo",
      },
      { kind: "document", id: "d1", title: "Login hardening spec" },
      { kind: "project", id: "p1", title: "Storefront" },
    ],
  });
  render(
    <ChatClientContext value={client}>
      <ChatProvider>
        <ChatsView />
      </ChatProvider>
    </ChatClientContext>,
  );
  const first = chats[0];
  if (first) {
    fireEvent.click(
      await screen.findByRole("button", {
        name: new RegExp(`^${title ?? first.chat.title}`),
      }),
    );
    await screen.findByRole("heading", { name: title ?? first.chat.title });
  }
  return client;
}
const one = (over: Parameters<typeof chatState>[0], items?: TranscriptItem[]) =>
  [{ chat: chatState(over), ...(items && { items }) }] satisfies MockChat[];
const composer = (name = "Message Codex") => screen.getByLabelText(name);
const type = (text: string, name?: string) =>
  fireEvent.change(composer(name), { target: { value: text } });
const button = (name: string | RegExp) => screen.getByRole("button", { name });
const noButton = (name: string | RegExp) =>
  expect(screen.queryByRole("button", { name })).toBeNull();
const openMenu = (name: string) =>
  fireEvent.keyDown(button(name), { key: "Enter" });

test("an idle Chat sends what was typed and shows the turn as working, not done", async () => {
  await open(one({ id: "c1", title: "Limiter" }));
  expect(button("Send")).toHaveProperty("disabled", true);
  type("Add a rate limiter");
  fireEvent.click(button("Send"));
  expect(await screen.findByText("Add a rate limiter")).toBeTruthy();
  expect((await screen.findByRole("status")).textContent).toContain("Working");
  await waitFor(() => expect(composer()).toHaveProperty("value", ""));
  // With nothing typed, the one button is Stop.
  expect(button("Stop")).toBeTruthy();
  noButton("Send");
});

test("while a turn runs, typed text can steer it or be queued, and the queue stays visible", async () => {
  await open(one({ id: "c1", title: "Limiter", activity: "working" }));
  type("also cover the admin login");
  expect(
    screen.getByText(
      "Send adds this to the turn in progress. Queue holds it until the turn ends.",
    ),
  ).toBeTruthy();
  // Stop stays beside Send and Queue while text is typed.
  expect(button("Stop")).toBeTruthy();
  fireEvent.click(button("Queue until this turn ends"));
  const queue = await screen.findByRole("list", { name: "Queued messages" });
  expect(within(queue).getByText("also cover the admin login")).toBeTruthy();
  type("use Redis");
  fireEvent.click(button("Send"));
  expect(await screen.findByText("use Redis")).toBeTruthy();
  expect(within(queue).queryByText("use Redis")).toBeNull();
  fireEvent.click(button("Remove queued message"));
  await waitFor(() =>
    expect(screen.queryByRole("list", { name: "Queued messages" })).toBeNull(),
  );
});

test("a harness that cannot be steered only offers Queue, and says why", async () => {
  await open(
    one({
      id: "c1",
      title: "Limiter",
      activity: "working",
      steering: { available: false },
    }),
  );
  type("then update the docs");
  noButton("Send");
  expect(button("Stop")).toBeTruthy();
  expect(
    screen.getByText(
      "Codex can't take messages mid-turn. This will be queued until the turn ends.",
    ),
  ).toBeTruthy();
  fireEvent.click(button("Queue"));
  const queue = await screen.findByRole("list", { name: "Queued messages" });
  expect(within(queue).getByText("then update the docs")).toBeTruthy();
});

test("Stop marks the turn, pauses the queue and waits for Resume", async () => {
  const client = await open(
    one({
      id: "c1",
      title: "Limiter",
      activity: "working",
      queue: [{ id: "q1", text: "then add tests" }],
    }),
  );
  fireEvent.click(button("Stop"));
  expect(
    await screen.findByText(
      "You stopped this turn. Edits already made are kept.",
    ),
  ).toBeTruthy();
  expect(
    screen.getByText("Queue paused. Nothing sends until you resume."),
  ).toBeTruthy();
  expect(screen.getByText("then add tests")).toBeTruthy();
  expect((await client.openChat("c1")).chat.activity).toBe("interrupted");
  fireEvent.click(button("Resume"));
  await waitFor(() =>
    expect(
      screen.queryByText("Queue paused. Nothing sends until you resume."),
    ).toBeNull(),
  );
});

test("an approval sets its command in code and its reason as prose", async () => {
  await open(
    one({ id: "c1", title: "Limiter", activity: "waiting" }, [
      { ...approval, reason: "Allow installing the PagerDuty client?" },
    ]),
  );
  const card = screen.getByRole("region", { name: "Approval request" });
  const command = within(card).getByText("npm install @pagerduty/pdjs");
  const reason = within(card).getByText(
    "Allow installing the PagerDuty client?",
  );
  expect(command.tagName).toBe("PRE");
  expect(reason.tagName).toBe("P");
  expect(command.contains(reason)).toBe(false);
});

test("an approval is answered once and becomes a receipt without buttons", async () => {
  await open(
    one({ id: "c1", title: "Limiter", activity: "waiting" }, [approval]),
  );
  const card = screen.getByRole("region", { name: "Approval request" });
  expect(within(card).getByText("npm install @pagerduty/pdjs")).toBeTruthy();
  fireEvent.click(within(card).getByRole("button", { name: "Allow once" }));
  const receipt = await screen.findByRole("region", {
    name: "Answered request",
  });
  expect(receipt.textContent).toContain('You chose "Allow once"');
  expect(within(receipt).queryByRole("button")).toBeNull();
});

test("an expired request cannot be answered", async () => {
  await open(
    one({ id: "c1", title: "Limiter" }, [{ ...approval, state: "expired" }]),
  );
  const card = screen.getByRole("region", { name: "Expired request" });
  expect(card.textContent).toContain(
    "Expired. The turn ended before this was answered.",
  );
  expect(within(card).queryByRole("button")).toBeNull();
});

test("answering a request that expired behind a lost update is refused, then the view resyncs", async () => {
  const client = await open(
    one({ id: "c1", title: "Limiter", activity: "waiting" }, [approval]),
  );
  // The expiry never reaches this view.
  client.dropChanges("c1", 1);
  act(() => client.push("c1", { ...approval, state: "expired" }));
  fireEvent.click(button("Allow once"));
  expect((await screen.findByRole("alert")).textContent).toBe(
    "This request is no longer waiting for an answer.",
  );
  // The next change exposes the gap; the view takes a fresh snapshot.
  act(() => client.patch("c1", { activity: "idle" }));
  expect(
    await screen.findByRole("region", { name: "Expired request" }),
  ).toBeTruthy();
  noButton("Allow once");
});

test("a question takes an option or a typed answer", async () => {
  const question: TranscriptItem = {
    id: "q-1",
    at,
    kind: "request",
    request: "question",
    title: "What should the limiter do when Redis is unreachable?",
    options: [
      {
        id: "open",
        label: "Fail open",
        description: "Let logins through and log a warning",
      },
      { id: "closed", label: "Fail closed" },
    ],
    free_text: true,
    state: "pending",
  };
  const client = await open(
    one({ id: "c1", title: "Limiter", activity: "waiting" }, [question]),
  );
  expect(
    screen.getByRole("region", { name: "Question from Codex" }),
  ).toBeTruthy();
  expect(screen.getByText("Or type your own answer below.")).toBeTruthy();
  type("Fail open for five minutes", "Answer Codex");
  fireEvent.click(button("Send"));
  expect((await screen.findByText(/You answered/)).textContent).toBeTruthy();
  const { items } = await client.openChat("c1");
  expect(items.filter((item) => item.kind === "user")).toEqual([]);
});

test("an uncertain delivery is never resent unless the person says so", async () => {
  const client = await open(
    one(
      {
        id: "c1",
        title: "Limiter",
        activity: "interrupted",
        problem: { kind: "uncertain_delivery", message_id: "u1" },
      },
      [
        {
          id: "u1",
          at,
          kind: "user",
          text: "Ship it",
          delivery: "uncertain",
        },
      ],
    ),
  );
  expect(
    within(screen.getByRole("list", { name: "Chats" })).getByText(
      "Not confirmed",
    ),
  ).toBeTruthy();
  expect(screen.getByText("Did Codex get your message?")).toBeTruthy();
  type("hello?");
  expect(button("Send")).toHaveProperty("disabled", true);
  fireEvent.click(button("Don't send"));
  expect(await screen.findByText("Not confirmed · set aside")).toBeTruthy();
  const { items, chat } = await client.openChat("c1");
  expect(items).toHaveLength(1);
  expect(chat.activity).toBe("idle");
});

test("failures say exactly what stopped the Chat and how to recover", async () => {
  const client = await open(
    one(
      {
        id: "c1",
        title: "Limiter",
        activity: "failed",
        problem: {
          kind: "usage_limit",
          past: true,
          resets_at: new Date(2026, 10, 12, 15, 0).getTime() / 1000,
        },
        queue: [{ id: "q1", text: "then add tests" }],
      },
      [reply("r1", "Half way there.")],
    ),
  );
  const notice = screen.getByRole("alert");
  expect(notice.textContent).toContain("Codex reached your usage limit");
  expect(notice.textContent).toContain(
    "It says the limit resets on Nov 12 at 3:00 PM. Your work so far is kept. ticketd won't switch model or billing.",
  );
  // It is why the last turn stopped: the person can still send.
  type("try again");
  expect(button("Send")).toHaveProperty("disabled", false);
  type("");
  // Output and queued input are retained; nothing is sent for the person.
  expect(screen.getAllByText("Half way there.").length).toBeGreaterThan(0);
  expect(screen.getByText("then add tests")).toBeTruthy();
  // Seen once opened, the row says the outcome in words without the dot.
  expect(
    within(screen.getByRole("list", { name: "Chats" })).getByRole("button", {
      name: /^Limiter/,
    }).textContent,
  ).toContain("Failed\u00a0· Codex reached your usage limit");

  act(() =>
    client.patch("c1", {
      problem: {
        kind: "sandbox_unavailable",
        help_url: "https://example.com/sandbox",
      },
    }),
  );
  const sandbox = await screen.findByText("Codex can't run commands here");
  expect(sandbox.closest("[data-tone]")?.getAttribute("data-tone")).toBe(
    "error",
  );
  expect(button(/Sandbox help/)).toBeTruthy();

  act(() =>
    client.patch("c1", {
      problem: { kind: "failed", message: "The process exited with code 1." },
    }),
  );
  expect(
    (await screen.findByText("Codex stopped with an error")).parentElement
      ?.textContent,
  ).toContain(
    "The process exited with code 1. What it finished before that is kept; the turn is not complete.",
  );
  fireEvent.click(button("Check again"));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});

test("a missing folder keeps the Chat readable and offers another folder", async () => {
  const client = await open(
    one(
      {
        id: "c1",
        title: "Reset email",
        activity: "failed",
        folder: {
          missing: true,
          path: "~/ticketd/chats/reset-email",
          name: "reset-email",
        },
        problem: {
          kind: "folder_missing",
          path: "~/ticketd/chats/reset-email",
        },
      },
      [reply("r1", "Drafted the copy.")],
    ),
  );
  expect(screen.getAllByText("Drafted the copy.").length).toBeGreaterThan(0);
  expect(screen.queryByLabelText("Message Codex")).toBeNull();
  expect(button("Harness and folder").textContent).toBe(
    "Codex · reset-email (missing)",
  );
  // The folder name is what shortens; the marker never is (U23).
  const marker = within(button("Harness and folder")).getByText("(missing)");
  expect(marker.closest(".truncate")).toBeNull();
  expect(marker.className).toContain("shrink-0");
  // The path reads like the folder popover's: one line, not a code block.
  const notice = screen.getByRole("alert");
  expect(within(notice).getByTitle("~/ticketd/chats/reset-email")).toBeTruthy();
  expect(notice.querySelector("code")).toBeNull();
  expect(notice.textContent).toContain("wasn't found. Nothing was re-run.");
  client.nextFolder = "~/code/emails";
  fireEvent.click(button("Pick another folder…"));
  expect(await screen.findByLabelText("Message Codex")).toBeTruthy();
  expect(button("Harness and folder").textContent).toBe("Codex · emails");
});

test("lost native history resumes the same Chat in a fresh session with chosen history", async () => {
  const client = await open(
    one(
      {
        id: "c1",
        title: "Limiter",
        activity: "failed",
        problem: { kind: "history_lost" },
      },
      [
        {
          id: "u1",
          at,
          kind: "user",
          text: "Add a limiter",
          delivery: "delivered",
        },
        reply("r1", "Added the limiter."),
      ],
    ),
  );
  expect(screen.queryByLabelText("Message Codex")).toBeNull();
  fireEvent.click(button("Resume in a fresh session…"));
  const dialog = await screen.findByRole("dialog", {
    name: "Resume in a fresh session",
  });
  const choices = within(dialog).getByRole("radiogroup", {
    name: "History to give the new session",
  });
  expect(
    within(choices).getByRole("radio", { name: /The last response/ }),
  ).toHaveProperty("checked", true);
  expect(within(choices).getByText("2 messages")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Resume" }));
  expect(
    await screen.findByText("Fresh session · started with the last response"),
  ).toBeTruthy();
  expect(await screen.findByLabelText("Message Codex")).toBeTruthy();
  // Nothing was sent on the person's behalf.
  const { items } = await client.openChat("c1");
  expect(items.filter((item) => item.kind === "user")).toHaveLength(1);
});

test("picking messages turns the transcript into the history picker", async () => {
  await open(
    one(
      {
        id: "c1",
        title: "Limiter",
        activity: "failed",
        problem: { kind: "history_lost" },
      },
      [
        {
          id: "u1",
          at,
          kind: "user",
          text: "Add a limiter",
          delivery: "delivered",
        },
        reply("r1", "Added the limiter."),
      ],
    ),
  );
  fireEvent.click(button("Resume in a fresh session…"));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(
    within(dialog).getByRole("radio", { name: "Let me pick messages…" }),
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Resume" }));
  expect(await screen.findByText("0 of 2 messages picked")).toBeTruthy();
  expect(button("Resume")).toHaveProperty("disabled", true);
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: "Include the reply: Added the limiter.",
    }),
  );
  expect(screen.getByText("1 of 2 messages picked")).toBeTruthy();
  fireEvent.click(button("Resume"));
  expect(
    await screen.findByText("Fresh session · started with 1 picked message"),
  ).toBeTruthy();
});

test("archive keeps the work running; trash stops it and restore re-runs nothing", async () => {
  const client = await open(
    one({ id: "kept", title: "Limiter", activity: "working" }),
  );
  openMenu("Chat actions");
  fireEvent.click(await screen.findByRole("menuitem", { name: "Archive" }));
  expect(await screen.findByRole("button", { name: "Unarchive" })).toBeTruthy();
  expect(
    await screen.findByText("No Chats yet. Start one with New Chat."),
  ).toBeTruthy();
  expect(button("Stop")).toBeTruthy();
  expect((await client.openChat("kept")).chat.activity).toBe("working");

  openMenu("Show active, archived or trashed Chats");
  fireEvent.click(await screen.findByRole("menuitem", { name: "Archived" }));
  expect(await screen.findByRole("heading", { name: "Archived" })).toBeTruthy();
  fireEvent.click(await screen.findByRole("button", { name: /^Limiter/ }));
  await screen.findByRole("button", { name: "Unarchive" });

  openMenu("Chat actions");
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Move to Trash" }),
  );
  expect(await screen.findByText(/^In Trash\. It was stopped/)).toBeTruthy();
  expect(screen.queryByLabelText("Message Codex")).toBeNull();
  expect(screen.queryByRole("group", { name: "Linked records" })).toBeNull();
  fireEvent.click(button("Restore"));
  expect(await screen.findByLabelText("Message Codex")).toBeTruthy();
  const { chat, items } = await client.openChat("kept");
  expect(chat).toMatchObject({ retention: "active", activity: "interrupted" });
  expect(items.filter((item) => item.kind === "user")).toEqual([]);
});

test("the list says which Chats need the person, in words as well as the dot", async () => {
  await open([
    {
      chat: chatState({
        id: "c1",
        title: "Alert on-call",
        activity: "waiting",
        links: [
          {
            kind: "ticket",
            id: "t13",
            reference: "T-13",
            title: "Page on-call",
            status: "In progress",
          },
        ],
      }),
      items: [approval],
    },
    { chat: chatState({ id: "c2", title: "Limiter", activity: "working" }) },
  ]);
  const rows = within(screen.getByRole("list", { name: "Chats" }));
  const waiting = rows.getByRole("button", { name: /^Alert on-call/ });
  expect(waiting.textContent).toContain(
    "Approval needed\u00a0· npm install @pagerduty/pdjs",
  );
  expect(waiting.textContent).toContain("T-13 · web-app");
  expect(waiting.getAttribute("aria-current")).toBe("true");
  expect(waiting.hasAttribute("data-attention")).toBe(true);
  const working = rows.getByRole("button", { name: /^Limiter/ });
  expect(working.textContent).toContain("Working");
  expect(working.hasAttribute("data-attention")).toBe(false);
});

test("a row's actions mark it unread or read and mute it, and say a refusal", async () => {
  const client = await open([
    { chat: chatState({ id: "c1", title: "Alert on-call" }) },
    {
      chat: chatState({ id: "c2", title: "Limiter", unseen: true }),
      items: [reply("r1", "All **done**")],
    },
  ]);
  const rows = within(screen.getByRole("list", { name: "Chats" }));
  const done = rows.getByRole("button", { name: /^Limiter/ });
  expect(done.textContent).toContain("Done\u00a0· All done");
  expect(done.textContent).toContain("unread");

  openMenu("Actions for Limiter");
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Mark as read" }),
  );
  await waitFor(() =>
    expect(
      rows.getByRole("button", { name: /^Limiter/ }).textContent,
    ).not.toContain("unread"),
  );
  // Seen, the row says its last line in words.
  expect(rows.getByRole("button", { name: /^Limiter/ }).textContent).toContain(
    "All done",
  );

  openMenu("Actions for Limiter");
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Mute notifications" }),
  );
  await waitFor(() =>
    expect(
      rows.getByRole("button", { name: /^Limiter/ }).textContent,
    ).toContain("muted"),
  );
  openMenu("Actions for Limiter");
  expect(
    await screen.findByRole("menuitem", { name: "Unmute notifications" }),
  ).toBeTruthy();
  fireEvent.keyDown(document.activeElement ?? document.body, {
    key: "Escape",
  });

  client.markUnread = async () => {
    throw new Error("The workspace is read-only.");
  };
  openMenu("Actions for Limiter");
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Mark as unread" }),
  );
  expect(await screen.findByText("The workspace is read-only.")).toBeTruthy();
});

test("a clicked notification opens its Chat under its own list", async () => {
  const client = await open([]);
  await act(async () => {
    await client.createChat({
      command_id: "x",
      harness_id: "codex",
      folder: null,
      links: [],
      message: "Rate-limit failed logins",
    });
  });
  await client.archive("chat-1");
  act(() => client.requestOpen({ chat_id: "chat-1", retention: "archived" }));
  expect(
    await screen.findByRole("heading", { name: "Rate-limit failed logins" }),
  ).toBe(document.activeElement);
  expect(screen.getByRole("heading", { name: "Archived" })).toBeTruthy();
});

test("a view that missed changes resyncs from a snapshot instead of showing a broken transcript", async () => {
  const client = await open(
    one({ id: "c1", title: "Limiter", activity: "working" }, [
      { id: "r1", at, kind: "response", text: "Reading", state: "streaming" },
    ]),
  );
  client.dropChanges("c1", 2);
  act(() => {
    client.streamText("c1", "r1", " the spec,");
    client.streamText("c1", "r1", " then the tests,");
    client.streamText("c1", "r1", " then writing.");
  });
  expect(
    await screen.findByText("Reading the spec, then the tests, then writing."),
  ).toBeTruthy();
});

test("a large transcript keeps up with many small streamed updates", async () => {
  const history: TranscriptItem[] = Array.from({ length: 300 }, (_, index) =>
    index % 2
      ? reply(`r${index}`, `Reply ${index}`)
      : {
          id: `u${index}`,
          at,
          kind: "user",
          text: `Message ${index}`,
          delivery: "delivered",
        },
  );
  const client = await open(
    one({ id: "c1", title: "Limiter", activity: "working" }, [
      ...history,
      { id: "live", at, kind: "response", text: "", state: "streaming" },
    ]),
  );
  expect(screen.getByText("Message 0")).toBeTruthy();
  // Deltas arrive in separate ticks, as coalesced host updates do.
  for (let batch = 0; batch < 20; batch += 1)
    act(() => {
      for (let part = 0; part < 25; part += 1)
        client.streamText("c1", "live", `${batch * 25 + part} `);
    });
  const expected = Array.from({ length: 500 }, (_, index) => index).join(" ");
  expect(await screen.findByText(expected)).toBeTruthy();
  expect(screen.getByText("Reply 299")).toBeTruthy();
});

test("each step reads as what it did, and opens to its output", async () => {
  await open(
    one({ id: "c1", title: "Limiter" }, [
      {
        id: "s1",
        at,
        kind: "steps",
        steps: [
          {
            kind: "edit",
            target: "src/auth/limiter.ts",
            targets: [{ text: "src/auth/limiter.ts" }],
          },
          {
            kind: "run",
            target: "npm run test:all",
            command: "npm run test:all",
            folder: "apps/desktop",
            state: "failed",
            exit_code: 1,
            output: "FAIL limiter.test.ts",
            truncated: { kept_bytes: 1_048_576, total_bytes: 3_565_158 },
          },
        ],
      },
    ]),
  );
  // A row with nothing to open is not a control.
  expect(screen.getByText("src/auth/limiter.ts").closest("button")).toBeNull();
  const line = button("Run npm run test:all, Failed");
  expect(line.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(line);
  expect(line.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByText("$ npm run test:all")).toBeTruthy();
  expect(screen.getByText("FAIL limiter.test.ts")).toBeTruthy();
  expect(screen.getByText("Exit 1 · in apps/desktop")).toBeTruthy();
  expect(
    screen.getByText(
      "Truncated: ticketd keeps the last 1 MiB of 3.4 MiB. Codex saw all of it.",
    ),
  ).toBeTruthy();
});

test("what the agent changed in ticketd is listed where it happened", async () => {
  await open(
    one({ id: "c1", title: "Limiter" }, [
      {
        id: "rec1",
        at,
        kind: "records",
        changes: [
          {
            kind: "status",
            reference: "T-12",
            title: "Rate-limit failed login attempts",
            from: "In progress",
            to: "In review",
          },
          { kind: "document", document_id: "d9", title: "Reset email copy" },
        ],
      },
    ]),
  );
  const block = within(
    screen.getByRole("list", { name: "Updated in ticketd" }),
  );
  expect(block.getByText("In progress → In review")).toBeTruthy();
  expect(block.getByText("Document created")).toBeTruthy();
  expect(
    screen.getByText('Created the Document "Reset email copy"'),
  ).toBeTruthy();
});

test("a response is saved as a Document only when asked", async () => {
  const client = await open(
    one({ id: "c1", title: "Limiter" }, [
      reply("r1", "# Login rate limiter\n\nWhat was built."),
    ]),
  );
  fireEvent.click(button("Save as Document"));
  const dialog = await screen.findByRole("dialog", {
    name: "Save as Document",
  });
  expect(within(dialog).getByLabelText("Title")).toHaveProperty(
    "value",
    "Login rate limiter",
  );
  expect(client.savedDocuments).toEqual([]);
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  expect(
    await screen.findByText("Saved “Login rate limiter” to Documents."),
  ).toBeTruthy();
  expect(client.savedDocuments).toEqual(["Login rate limiter"]);
});

test("records are linked by title and unlinked from their chip", async () => {
  await open(one({ id: "c1", title: "Limiter" }));
  fireEvent.click(button("Link a ticket, Document or Project"));
  fireEvent.change(
    await screen.findByLabelText("Search tickets, Documents and Projects"),
    { target: { value: "wait" } },
  );
  fireEvent.click(await screen.findByRole("button", { name: /T-14/ }));
  const links = within(
    await screen.findByRole("group", { name: "Linked records" }),
  );
  expect(
    await links.findByRole("button", {
      name: "Open T-14 Show the remaining wait time",
    }),
  ).toBeTruthy();
  fireEvent.click(
    links.getByRole("button", {
      name: "Remove the link to T-14 Show the remaining wait time",
    }),
  );
  await waitFor(() =>
    expect(links.queryByRole("button", { name: /Open T-14/ })).toBeNull(),
  );
});

test("the folder popover names the other Chats sharing the folder", async () => {
  await open(
    one({
      id: "c1",
      title: "Limiter",
      harness: { permissions: "Uses your Codex settings." },
      folder: { shared_with: ["Alert on-call"] },
    }),
  );
  fireEvent.click(button("Harness and folder"));
  const popover = await screen.findByRole("dialog", {
    name: "Harness and folder",
  });
  expect(popover.textContent).toContain("~/code/web-app");
  expect(popover.textContent).toContain("Also used by Alert on-call");
  expect(popover.textContent).toContain("Uses your Codex settings.");
});

test("after reopening the window the view says it is catching up while work continues", async () => {
  await open(
    one({
      id: "reopened",
      title: "Limiter",
      activity: "working",
      catching_up: true,
    }),
  );
  expect(screen.getByRole("status").textContent).toBe("Catching up…");
  expect(button("Stop")).toBeTruthy();
});

test("while its session opens the working line says so and counts, then reads as working", async () => {
  const client = await open(
    one({ id: "c1", title: "Limiter", activity: "working", opening: "resume" }),
  );
  expect(screen.getByRole("status").textContent).toBe(
    "Resuming the Codex session… · 0s",
  );
  act(() => client.patch("c1", { opening: "start" }));
  expect(screen.getByRole("status").textContent).toBe("Starting Codex… · 0s");
  act(() =>
    client.patch("c1", {
      opening: null,
      doing: { label: "Working", since: new Date().toISOString() },
    }),
  );
  expect(screen.getByRole("status").textContent).toBe("Working · 0s");
});

test("New Chat keeps the draft when the harness is missing and starts once it is found", async () => {
  const client = await open([]);
  client.setHarnesses([
    {
      id: "codex",
      name: "Codex",
      status: "not_installed",
      help_url: "https://example.com/install",
    },
  ]);
  client.nextFolder = "~/code/web-app";
  fireEvent.click(await screen.findByRole("button", { name: "New Chat" }));
  expect(
    await screen.findByRole("heading", { name: "What should we work on?" }),
  ).toBeTruthy();
  type("Draft the reset email", "Describe a task or ask a question");
  expect(await screen.findByText("Codex isn't installed")).toBeTruthy();
  expect(button("Send")).toHaveProperty("disabled", true);

  client.setHarnesses([{ id: "codex", name: "Codex", status: "ready" }]);
  fireEvent.click(button("Check again"));
  await waitFor(() => expect(button("Send")).toHaveProperty("disabled", false));
  expect(composer("Describe a task or ask a question")).toHaveProperty(
    "value",
    "Draft the reset email",
  );
  fireEvent.click(button("Send"));
  expect(
    await screen.findByRole("heading", { name: "Draft the reset email" }),
  ).toBeTruthy();
  // No Project or ticket was needed; ticketd keeps a folder for the Chat.
  expect((await client.openChat("chat-1")).chat.folder.managed).toBe(true);
});

test("a first message that was not sent opens the Chat with the text, and New Chat starts over", async () => {
  const mock = createMockChatClient({
    enabled: true,
    chats: one({ id: "c1", title: "Left behind" }),
  });
  const asked: Parameters<typeof mock.createChat>[0][] = [];
  const outcomes: (() => Promise<{ chat_id: string; send_error?: string }>)[] =
    [
      // The Chat was made; its first message was not saved.
      async () => ({ chat_id: "c1", send_error: "storage failed" }),
      // Nothing is known to have been made.
      () => Promise.reject(new Error("bridge closed")),
      () => Promise.reject(new Error("bridge closed")),
      async () => ({ chat_id: "c1" }),
    ];
  const client = {
    ...mock,
    createChat: (input: Parameters<typeof mock.createChat>[0]) => {
      asked.push(input);
      const next = outcomes[asked.length - 1];
      return next ? next() : mock.createChat(input);
    },
  };
  render(
    <ChatClientContext value={client}>
      <ChatProvider>
        <ChatsView />
      </ChatProvider>
    </ChatClientContext>,
  );
  const newChat = async () => {
    fireEvent.click(await screen.findByRole("button", { name: "New Chat" }));
    await waitFor(() => expect(button("Send")).toBeTruthy());
  };
  const describe = "Describe a task or ask a question";
  const send = async (text: string) => {
    type(text, describe);
    await waitFor(() =>
      expect(button("Send")).toHaveProperty("disabled", false),
    );
    fireEvent.click(button("Send"));
  };

  await newChat();
  await send("first try");
  // The Chat that exists is opened, with the unsent words ready to send there.
  await screen.findByRole("heading", { name: "Left behind" });
  expect(composer()).toHaveProperty("value", "first try");
  expect(screen.getByRole("alert").textContent).toContain("storage failed");

  // New Chat starts clean: a changed message is a new request, not a conflict.
  await newChat();
  expect(composer(describe)).toHaveProperty("value", "");
  await send("something else");
  await screen.findByText(/Could not start the Chat: bridge closed/);
  expect(asked[1]?.command_id).not.toBe(asked[0]?.command_id);
  // Sending the very same request again repeats its id, so it finds what it made.
  expect(composer(describe)).toHaveProperty("value", "something else");
  fireEvent.click(button("Send"));
  await waitFor(() => expect(asked).toHaveLength(3));
  expect(asked[2]?.command_id).toBe(asked[1]?.command_id);
  // Changing what is asked for makes it a new request.
  await screen.findByText(/Could not start the Chat: bridge closed/);
  await send("something else entirely");
  await waitFor(() => expect(asked).toHaveLength(4));
  expect(asked[3]?.command_id).not.toBe(asked[2]?.command_id);
});

test("New Chat says how the harness is signed in before the first message is sent", async () => {
  const client = await open([]);
  client.setHarnesses([
    {
      id: "codex",
      name: "Codex",
      status: "not_subscription",
      message:
        "Codex 1.0 is signed in with an API key; Codex bills usage there.",
      command: "codex login",
    },
  ]);
  fireEvent.click(await screen.findByRole("button", { name: "New Chat" }));
  type("Draft the reset email", "Describe a task or ask a question");

  expect(
    await screen.findByText("Codex isn't using a subscription"),
  ).toBeTruthy();
  expect(screen.getByText(/Codex bills usage there\./)).toBeTruthy();
  // It is told, not blocked.
  expect(button("Send")).toHaveProperty("disabled", false);

  client.setHarnesses([
    { id: "codex", name: "Codex", status: "sign_in_unknown" },
  ]);
  fireEvent.click(button("Check again"));
  expect(
    await screen.findByText("ticketd can't check Codex's sign-in"),
  ).toBeTruthy();
});

test("a Project is linked like a ticket or Document and has no page to open", async () => {
  await open(one({ id: "c1", title: "Limiter" }));
  fireEvent.click(button("Link a ticket, Document or Project"));
  fireEvent.change(
    await screen.findByLabelText("Search tickets, Documents and Projects"),
    { target: { value: "store" } },
  );
  fireEvent.click(await screen.findByRole("button", { name: "Storefront" }));
  const links = within(
    await screen.findByRole("group", { name: "Linked records" }),
  );
  expect(await links.findByText("Storefront")).toBeTruthy();
  expect(links.queryByRole("button", { name: /Open/ })).toBeNull();
  fireEvent.click(
    links.getByRole("button", {
      name: "Remove the link to the Project Storefront",
    }),
  );
  await waitFor(() => expect(links.queryByText("Storefront")).toBeNull());
});

test("a managed folder reads as the ticketd folder, and its path has no verbatim prefix", async () => {
  await open(
    one({
      id: "c1",
      title: "Limiter",
      folder: {
        managed: true,
        name: "f4f684bc-abfa-4335-a59d-4700c27c520e",
        path: String.raw`\\?\C:\ws\workspace.sqlite3.chats\f4f684bc-abfa-4335-a59d-4700c27c520e`,
      },
    }),
  );
  expect(button("Harness and folder").textContent).toBe(
    "Codex · ticketd folder",
  );
  expect(screen.getByRole("list", { name: "Chats" }).textContent).not.toContain(
    "f4f684bc",
  );
  fireEvent.click(button("Harness and folder"));
  const popover = await screen.findByRole("dialog", {
    name: "Harness and folder",
  });
  expect(popover.textContent).toContain(String.raw`C:\ws`);
  expect(popover.textContent).not.toContain("?");
});

test("an incompatible harness notice keeps the full stop with the path", async () => {
  const client = await open([]);
  const path = "/opt/tools/a/very/long/folder/for/the/codex/executable/codex";
  client.setHarnesses([
    {
      id: "codex",
      name: "Codex",
      status: "incompatible",
      path,
      message: `Found Codex 0.1.0 at \`${path}\`. ticketd needs Codex 0.162.1 or newer.`,
    },
  ]);
  fireEvent.click(await screen.findByRole("button", { name: "New Chat" }));
  const sentence = await screen.findByText(/ticketd needs Codex 0\.162\.1/);
  const wrapper = sentence.querySelector(".notice-path");
  expect(wrapper?.textContent?.endsWith(".")).toBe(true);
  expect(wrapper?.nextSibling?.textContent?.startsWith(".")).toBe(false);
});

test("the link picker asks for a name before it lists anything", async () => {
  await open(one({ id: "c1", title: "Limiter" }));
  fireEvent.click(button("Link a ticket, Document or Project"));
  expect(
    await screen.findByText("Type part of a name to find it."),
  ).toBeTruthy();
  expect(screen.queryByText("Nothing left to link.")).toBeNull();
});

test("New Chat says it is checking the harnesses until the probe answers", async () => {
  await open([]);
  fireEvent.click(await screen.findByRole("button", { name: "New Chat" }));
  expect(
    screen.getByRole("button", {
      name: "Harness: checking which are installed",
    }).textContent,
  ).toBe("Checking…");
  expect(
    (await screen.findByRole("button", { name: "Harness: Claude Code" }))
      .textContent,
  ).toBe("Claude Code");
});
