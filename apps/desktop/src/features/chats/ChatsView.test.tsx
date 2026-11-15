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
  type Step,
  type TranscriptItem,
} from "@/features/chats/client";
import { ChatProvider } from "@/features/chats/ChatProvider";
import { ChatsView } from "@/features/chats/ChatsView";
import { ProjectNavigation } from "@/features/documents/navigation";
import { drafts } from "@/features/chats/drafts";
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

afterEach(() => {
  cleanup();
  // What was typed in one test is not a draft in the next.
  drafts.clear();
});

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
  title: "Codex wants to run",
  subject: "npm install @pagerduty/pdjs",
  options: [
    { id: "once", label: "Allow once" },
    { id: "session", label: "Allow for this session" },
    { id: "deny", label: "Deny" },
  ],
  free_text: false,
  state: "pending",
};

async function open(
  chats: MockChat[],
  title?: string,
  openProject: (id: string) => void = () => {},
) {
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
    <ProjectNavigation.Provider value={openProject}>
      <ChatClientContext value={client}>
        <ChatProvider>
          <ChatsView />
        </ChatProvider>
      </ChatClientContext>
    </ProjectNavigation.Provider>,
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
const conversation = () =>
  within(document.querySelector<HTMLElement>(".chat-scroll")!);
/** The working line's words. */
const working = () => document.querySelector(".chat-working")?.textContent;
const openMenu = (name: string) =>
  fireEvent.keyDown(button(name), { key: "Enter" });

test("an idle Chat sends what was typed and shows the turn as working, not done", async () => {
  await open(one({ id: "c1", title: "Limiter" }));
  // Send names its action even while there is nothing to send; no Stop yet.
  expect(button("Send")).toHaveProperty("disabled", true);
  noButton("Stop");
  type("Add a rate limiter");
  fireEvent.click(button("Send"));
  expect(await screen.findByText("Add a rate limiter")).toBeTruthy();
  // The turn's clock counts from the host's start time.
  expect(working()).toMatch(/^Working for \d/);
  // One polite status says the turn started.
  expect(document.querySelector(".chat-dock [aria-live]")?.textContent).toBe(
    "Working",
  );
  await waitFor(() =>
    expect(composer("Steer Codex")).toHaveProperty("value", ""),
  );
  // A turn runs: Stop sits beside the button, which now reads Steer.
  expect(button("Stop").getAttribute("aria-keyshortcuts")).toBe("Escape");
  expect(button("Steer")).toHaveProperty("disabled", true);
  noButton("Send");
});

test("while a turn runs, Enter steers, Cmd+Enter queues, and the caret holds both", async () => {
  await open(
    one({
      id: "c1",
      title: "Limiter",
      activity: "working",
      steering: {
        available: true,
        effect: "Joins after the current tool finishes",
      },
    }),
  );
  type("also cover the admin login", "Steer Codex");
  fireEvent.keyDown(composer("Steer Codex"), { key: "Enter", metaKey: true });
  const queue = await screen.findByRole("list", { name: "Queued messages" });
  expect(within(queue).getByText("also cover the admin login")).toBeTruthy();
  expect(screen.getByText("Queued 1 · After this turn")).toBeTruthy();

  type("use Redis", "Steer Codex");
  fireEvent.keyDown(composer("Steer Codex"), { key: "Enter" });
  expect(await screen.findByText("use Redis")).toBeTruthy();
  expect(within(queue).queryByText("use Redis")).toBeNull();

  // With nothing typed there is nothing to send another way.
  expect(button("More ways to send")).toHaveProperty("disabled", true);
  type("and the reset link", "Steer Codex");
  openMenu("More ways to send");
  const menu = await screen.findByRole("menu");
  expect(within(menu).getByText("Steer now")).toBeTruthy();
  expect(
    within(menu).getByText("Joins after the current tool finishes"),
  ).toBeTruthy();
  fireEvent.click(within(menu).getByRole("menuitem", { name: /Queue/ }));
  expect(await within(queue).findByText("and the reset link")).toBeTruthy();

  for (const remove of screen.getAllByRole("button", {
    name: "Remove from queue",
  }))
    fireEvent.click(remove);
  await waitFor(() =>
    expect(screen.queryByRole("list", { name: "Queued messages" })).toBeNull(),
  );
});

test("a harness that cannot be steered reads Queue, with no caret", async () => {
  await open(
    one({
      id: "c1",
      title: "Limiter",
      activity: "working",
      steering: { available: false },
    }),
  );
  type("then update the docs", "Queue for Codex");
  noButton("Send");
  noButton("Steer");
  noButton("More ways to send");
  expect(button("Stop")).toBeTruthy();
  expect(button("Queue").getAttribute("aria-description")).toContain(
    "Codex can't steer, so this waits for the turn to end.",
  );
  fireEvent.click(button("Queue"));
  const queue = await screen.findByRole("list", { name: "Queued messages" });
  expect(within(queue).getByText("then update the docs")).toBeTruthy();
  // Send now cannot reach a turn that cannot be steered.
  noButton("Send now");
});

test("a steer the harness refused is a queue card that says so and why", async () => {
  await open(
    one({
      id: "c1",
      title: "Limiter",
      activity: "working",
      queue: [
        {
          id: "q1",
          text: "also cover the admin login",
          refused_steer: "a tool is still running",
        },
      ],
    }),
  );
  const queue = await screen.findByRole("list", { name: "Queued messages" });
  expect(
    within(queue).getByText("Couldn't steer; queued · a tool is still running"),
  ).toBeTruthy();
});

test("Esc stops the turn from an empty box and pauses the queue, which waits for Resume", async () => {
  const client = await open(
    one({
      id: "c1",
      title: "Limiter",
      activity: "working",
      queue: [{ id: "q1", text: "then add tests" }],
    }),
  );
  // With a draft in the box, Esc is not a stop.
  type("a draft", "Steer Codex");
  fireEvent.keyDown(composer("Steer Codex"), { key: "Escape" });
  expect((await client.openChat("c1")).chat.activity).toBe("working");
  type("", "Steer Codex");
  fireEvent.keyDown(composer("Steer Codex"), { key: "Escape" });
  expect(
    await screen.findByText(
      "You stopped this turn. Edits already made are kept.",
    ),
  ).toBeTruthy();
  // The queue shows it is paused.
  expect(screen.getByText(/^Queued \d+ · Paused$/)).toBeTruthy();
  expect(screen.getByText("then add tests")).toBeTruthy();
  expect((await client.openChat("c1")).chat.activity).toBe("interrupted");
  fireEvent.click(button("Resume"));
  await waitFor(() => expect(screen.queryByText(/· Paused$/)).toBeNull());
});

test("Esc is not a stop from a request or just after closing a menu; Stop leaves focus in the box", async () => {
  const client = await open(
    one({ id: "c1", title: "Limiter", activity: "working" }, [approval]),
  );
  const box = () =>
    document.querySelector<HTMLTextAreaElement>(".chat-composer textarea")!;
  const stillWorking = async () =>
    expect((await client.openChat("c1")).chat.activity).toBe("working");
  fireEvent.keyDown(button("Allow once"), { key: "Escape" });
  await stillWorking();
  // A menu takes the first Esc; the second, a moment later, is the same habit.
  const menu = document.createElement("div");
  menu.setAttribute("role", "menu");
  document.body.append(menu);
  fireEvent.keyDown(box(), { key: "Escape" });
  menu.remove();
  fireEvent.keyDown(box(), { key: "Escape" });
  await stillWorking();
  fireEvent.click(button("Stop"));
  expect(document.activeElement).toBe(box());
});

test("Stop waits while stopping and is the retry once the stop is not confirmed", async () => {
  const client = await open(
    one({ id: "c1", title: "Limiter", activity: "working", stopping: true }),
  );
  expect(button("Stop")).toHaveProperty("disabled", true);
  // Send waits for the turn to end.
  type("next", "Message Codex");
  expect(button("Send")).toHaveProperty("disabled", true);
  act(() =>
    client.patch("c1", {
      stopping: false,
      problem: { kind: "stop_unconfirmed" },
    }),
  );
  expect(await screen.findByText("Stop not confirmed")).toBeTruthy();
  expect(screen.getByText("Codex may still be running.")).toBeTruthy();
  noButton("Check again");
  expect(button("Stop")).toHaveProperty("disabled", false);
});

test("a queued message can be sent now, alone, or moved back into the message box", async () => {
  const client = await open(
    one({
      id: "c1",
      title: "Limiter",
      queue_paused: true,
      queue: [
        { id: "q1", text: "then add tests" },
        { id: "q2", text: "and a changelog entry" },
      ],
    }),
  );
  type("draft");
  const second = screen.getByText("and a changelog entry").closest("li");
  if (!second) throw new Error("no card");
  fireEvent.click(
    within(second).getByRole("button", { name: "Edit in the message box" }),
  );
  await waitFor(() =>
    expect(composer()).toHaveProperty(
      "value",
      "draft\n\nand a changelog entry",
    ),
  );
  expect(
    screen.queryByText("and a changelog entry", { selector: "li *" }),
  ).toBeNull();

  fireEvent.click(button("Send now"));
  expect(
    await screen.findByText("then add tests", { selector: ".chat-you *" }),
  ).toBeTruthy();
  const { chat } = await client.openChat("c1");
  expect(chat.queue).toEqual([]);
  expect(chat.queue_paused).toBe(true);
});

test("an approval's reason sets its `code spans` in mono, without the backticks", async () => {
  await open(
    one({ id: "c1", title: "Limiter", activity: "waiting" }, [
      {
        ...approval,
        reason: "Allow appending the `verified` line to hello.txt?",
      },
    ]),
  );
  const reason = document.querySelector(".chat-request-reason")!;
  expect(reason.textContent).toBe(
    "Allow appending the verified line to hello.txt?",
  );
  expect(within(reason as HTMLElement).getByText("verified").tagName).toBe(
    "CODE",
  );
});

test("a pending approval waits in the dock with its command inline, never in the transcript", async () => {
  await open(
    one({ id: "c1", title: "Limiter", activity: "waiting" }, [
      { ...approval, reason: "Allow installing the PagerDuty client?" },
    ]),
  );
  const request = screen.getByRole("group", {
    name: "Codex wants to run npm install @pagerduty/pdjs",
  });
  expect(within(request).getByText("npm install @pagerduty/pdjs").tagName).toBe(
    "CODE",
  );
  expect(request.getAttribute("aria-describedby")).toBeTruthy();
  expect(
    within(request).getByText("Allow installing the PagerDuty client?").tagName,
  ).toBe("P");
  const conversation = document.querySelector(".chat-scroll");
  expect(conversation?.textContent).not.toContain("npm install");
  // Typed text never answers an approval: the button keeps the turn's word.
  type("and pin the version", "Steer Codex");
  expect(button("Steer")).toBeTruthy();
});

test("an approval is answered from the dock and leaves no receipt row of its own", async () => {
  await open(
    one({ id: "c1", title: "Limiter", activity: "waiting" }, [approval]),
  );
  fireEvent.click(button("Allow once"));
  // Its decision is told on the step it was asked for, never as a receipt.
  await waitFor(() =>
    expect(screen.queryByRole("group", { name: /wants to run/ })).toBeNull(),
  );
  expect(screen.queryByText(/Allowed ·/)).toBeNull();
  // Answering returns focus to the message box.
  expect(document.activeElement).toBe(composer("Steer Codex"));
});

test("an expired request cannot be answered", async () => {
  await open(
    one({ id: "c1", title: "Limiter" }, [{ ...approval, state: "expired" }]),
  );
  // What expired is set in mono, as step targets are (CH-30).
  const receipt = screen.getByText("npm install @pagerduty/pdjs");
  expect(receipt.tagName).toBe("CODE");
  expect(receipt.parentElement?.textContent).toBe(
    "Expired · npm install @pagerduty/pdjs",
  );
  expect(receipt.closest("button")).toBeNull();
  noButton("Allow once");
});

test("answering a request that expired behind a lost update is refused, then the view resyncs", async () => {
  const client = await open(
    one({ id: "c1", title: "Limiter", activity: "waiting" }, [approval]),
  );
  // The expiry never reaches this view.
  client.dropChanges("c1", 1);
  act(() => client.push("c1", { ...approval, state: "expired" }));
  fireEvent.click(button("Allow once"));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Couldn't apply your answer. The request had already closed.",
  );
  // The next change exposes the gap; the view takes a fresh snapshot.
  act(() => client.patch("c1", { activity: "idle" }));
  await waitFor(() =>
    expect(document.querySelector(".chat-receipt")?.textContent).toBe(
      "Expired · npm install @pagerduty/pdjs",
    ),
  );
  noButton("Allow once");
});

const question: TranscriptItem = {
  id: "q-1",
  at,
  kind: "request",
  request: "question",
  title: "Codex is asking you",
  subject: "What should the limiter do when Redis is unreachable?",
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

test("a question takes an option by key inside the request, or a typed answer", async () => {
  const client = await open(
    one({ id: "c1", title: "Limiter", activity: "waiting" }, [question]),
  );
  const request = screen.getByRole("group", {
    name: "What should the limiter do when Redis is unreachable?",
  });
  const open_ = within(request).getByRole("button", { name: /Fail open/ });
  expect(open_.getAttribute("aria-keyshortcuts")).toBe("1");
  // ↑ from the empty message box reaches the first option; ↓ from the last
  // returns.
  const box = composer("Answer, or pick above");
  box.focus();
  fireEvent.keyDown(box, { key: "ArrowUp" });
  expect(document.activeElement).toBe(open_);
  const closed = within(request).getByRole("button", { name: "Fail closed" });
  closed.focus();
  fireEvent.keyDown(closed, { key: "ArrowDown" });
  expect(document.activeElement).toBe(box);

  type("Fail open for five minutes", "Answer, or pick above");
  fireEvent.click(button("Send"));
  expect(
    await screen.findByText("Answered · Fail open for five minutes"),
  ).toBeTruthy();
  const { items } = await client.openChat("c1");
  expect(items.filter((item) => item.kind === "user")).toEqual([]);
});

test("digits pick a question's option only while focus is inside the request", async () => {
  await open(
    one({ id: "c1", title: "Limiter", activity: "waiting" }, [question]),
  );
  fireEvent.keyDown(composer("Answer, or pick above"), { key: "2" });
  expect(
    screen.getByRole("group", { name: /Redis is unreachable/ }),
  ).toBeTruthy();
  fireEvent.keyDown(button(/Fail open/), { key: "2" });
  expect(await screen.findByText("Answered · Fail closed")).toBeTruthy();
});

test("a request arriving mid-draft takes no focus, and the draft keeps its meaning", async () => {
  const client = await open(
    one({ id: "c1", title: "Limiter", activity: "working" }),
  );
  composer("Steer Codex").focus();
  type("use Redis", "Steer Codex");
  act(() => {
    client.push("c1", question);
    client.patch("c1", { activity: "waiting" });
  });
  await screen.findByRole("group", { name: /Redis is unreachable/ });
  expect(composer("Steer Codex")).toHaveProperty("value", "use Redis");
  // A request never takes focus from the message box.
  expect(document.activeElement).toBe(composer("Steer Codex"));
  expect(button("Steer")).toBeTruthy();
  // Emptied, the box answers the question.
  type("", "Steer Codex");
  expect(composer("Answer, or pick above")).toBeTruthy();
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
    "It resets on Nov 12 at 3:00 PM. The last turn stopped there; your work so far is kept.",
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
  // The FolderX icon says missing; the accessible name says it in words.
  expect(button("Folder reset-email, missing").textContent).toBe("reset-email");
  // The path reads like the folder popover's: one line, not a code block.
  const notice = screen.getByRole("alert");
  expect(notice.querySelector('[data-slot="path-text"]')?.textContent).toBe(
    "~/ticketd/chats/reset-email",
  );
  expect(notice.querySelector("code")).toBeNull();
  expect(notice.textContent).toContain("wasn't found. Nothing was re-run.");
  client.nextFolder = "~/code/emails";
  fireEvent.click(button("Choose a folder…"));
  expect(await screen.findByLabelText("Message Codex")).toBeTruthy();
  expect(button("Folder emails").textContent).toBe("emails");
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
  expect(await screen.findByText("No Chats yet")).toBeTruthy();
  expect(button("Stop")).toBeTruthy();
  expect((await client.openChat("kept")).chat.activity).toBe("working");

  openMenu("Chats");
  fireEvent.click(
    await screen.findByRole("menuitemradio", { name: "Archived Chats" }),
  );
  expect(
    await screen.findByRole("heading", { name: "Archived Chats" }),
  ).toBeTruthy();
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
  // One context item: the first ticket, not the folder (#368).
  expect(waiting.textContent).toContain("T-13");
  expect(waiting.textContent).not.toContain("web-app");
  expect(waiting.getAttribute("aria-current")).toBe("true");
  // Read in order: title, harness, status, context.
  expect(waiting.textContent?.startsWith("Alert on-call, Codex,")).toBe(true);
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

test("a clicked notification about a request focuses that request's title", async () => {
  const client = await open([
    ...one({ id: "c1", title: "Limiter", activity: "waiting" }, [approval]),
    ...one({ id: "c2", title: "Other" }),
  ]);
  fireEvent.click(await screen.findByRole("button", { name: /^Other/ }));
  act(() => client.requestOpen({ chat_id: "c1", retention: "active" }));
  const title = await screen.findByRole("heading", { name: /wants to run/ });
  await waitFor(() => expect(document.activeElement).toBe(title));
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
  expect(screen.getByRole("heading", { name: "Archived Chats" })).toBeTruthy();
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

const inTurn = (item: TranscriptItem): TranscriptItem => ({
  ...item,
  turn_id: "t1",
});
const turnTiming = (
  outcome: Extract<TranscriptItem, { kind: "turn" }>["outcome"],
  ended?: string,
): TranscriptItem => ({
  id: "turn:t1",
  at,
  kind: "turn",
  turn_id: "t1",
  started_at: at,
  ...(ended && { ended_at: ended }),
  outcome,
});
const youSaid: TranscriptItem = {
  id: "u1",
  at,
  kind: "user",
  text: "Rate-limit failed logins",
  delivery: "delivered",
  turn_id: "t1",
};
const failedRun: Step = {
  kind: "run",
  target: "npm run test:all",
  command: "npm run test:all",
  folder: "apps/desktop",
  state: "failed",
  exit_code: 1,
  output: "FAIL limiter.test.ts",
  truncated: { kept_bytes: 1_048_576, total_bytes: 3_565_158 },
};

test("a finished turn folds under one row, its final response outside, and opens to each step's output", async () => {
  await open(
    one({ id: "c1", title: "Limiter" }, [
      youSaid,
      turnTiming("completed", "2026-11-10T10:02:13Z"),
      inTurn({
        id: "s1",
        at,
        kind: "steps",
        steps: [
          {
            kind: "edit",
            target: "src/auth/limiter.ts",
            targets: [{ text: "src/auth/limiter.ts" }],
          },
          failedRun,
        ],
      }),
      inTurn(reply("r1", "The limiter is in.")),
    ]),
  );
  const row = button("Worked for 2m 13s · 1 failed");
  expect(row.getAttribute("aria-expanded")).toBe("false");
  // Result first: the answer is outside the fold, the work inside it.
  expect(conversation().getByText("The limiter is in.")).toBeTruthy();
  expect(screen.queryByText("src/auth/limiter.ts")).toBeNull();
  fireEvent.click(row);
  expect(row.getAttribute("aria-expanded")).toBe("true");
  const body = screen.getByRole("group", {
    name: "Worked for 2m 13s · 1 failed",
  });
  expect(row.getAttribute("aria-controls")).toBe(body.id);
  // A row with nothing to open is not a control; its file name is.
  expect(
    within(body)
      .getByRole("button", { name: "Open src/auth/limiter.ts" })
      .closest(".chat-steps")?.tagName,
  ).toBe("DIV");
  const line = button("Run npm run test:all, Failed");
  fireEvent.click(line);
  expect(line.getAttribute("aria-expanded")).toBe("true");
  const output = screen.getByRole("region", {
    name: "Output of npm run test:all",
  });
  expect(output.textContent).toBe("$ npm run test:all\n\nFAIL limiter.test.ts");
  expect(output.tabIndex).toBe(0);
  expect(screen.getByText("Exit 1 · in apps/desktop")).toBeTruthy();
  expect(
    screen.getByText(
      "Truncated: ticketd keeps the last 1 MiB of 3.4 MiB. Codex saw all of it.",
    ),
  ).toBeTruthy();
  // Your toggle wins: closing hides the work again.
  fireEvent.click(row);
  expect(screen.queryByRole("group", { name: /Worked for/ })).toBeNull();
});

test("a stopped turn folds too, with its stop marker below the response", async () => {
  await open(
    one({ id: "c1", title: "Migrate" }, [
      youSaid,
      turnTiming("stopped", "2026-11-10T10:00:40Z"),
      inTurn({
        id: "s1",
        at,
        kind: "steps",
        steps: [{ ...failedRun, state: "running" }],
      }),
      { id: "t1", at, kind: "marker", reason: "stopped", turn_id: "t1" },
    ]),
    "Migrate",
  );
  fireEvent.click(button("Stopped after 40s · 1 not finished"));
  expect(button("Run npm run test:all, Not finished")).toBeTruthy();
  expect(
    screen.getByText("You stopped this turn. Edits already made are kept."),
  ).toBeTruthy();
});

test("while a turn runs its steps show as they start, and the working line only between steps", async () => {
  const client = await open(
    one(
      {
        id: "c1",
        title: "Limiter",
        activity: "working",
        doing: { label: "Working", since: at },
      },
      [
        youSaid,
        turnTiming("active"),
        inTurn({
          id: "s1",
          at,
          kind: "steps",
          steps: [
            {
              kind: "run",
              target: "npm test",
              command: "npm test",
              state: "running",
              started_at: new Date(Date.now() - 12_000).toISOString(),
            },
          ],
        }),
      ],
    ),
  );
  // Nothing folds while it runs; the running row carries the turn's one spinner.
  noButton(/Worked/);
  const running = button("Running npm test");
  expect(running.textContent).toBe("Running npm test · 12s");
  expect(running.querySelector(".chat-spin")).toBeTruthy();
  expect(working()).toBeUndefined();
  act(() =>
    client.push(
      "c1",
      inTurn({
        id: "s1",
        at,
        kind: "steps",
        steps: [{ kind: "run", target: "npm test", command: "npm test" }],
      }),
    ),
  );
  expect(button("Ran npm test")).toBeTruthy();
  // MOTION-9: the line waits a moment, so steps close together keep the slot.
  expect(working()).toBeUndefined();
  expect(
    await waitFor(() => {
      const line = working();
      if (!line) throw new Error("not yet");
      return line;
    }),
  ).toMatch(/^Working for \d/);
});

test("an answered approval folds into its step row, which says the decision", async () => {
  await open(
    one({ id: "c1", title: "Limiter", activity: "working" }, [
      youSaid,
      turnTiming("active"),
      inTurn({
        ...approval,
        state: "answered",
        outcome: "You allowed this for this session",
        folded: true,
      }),
      inTurn({
        id: "s1",
        at,
        kind: "steps",
        steps: [
          {
            ...failedRun,
            state: "done",
            output: null,
            truncated: null,
            decision: "You allowed this for this session",
          },
        ],
      }),
    ]),
  );
  const row = button("Ran npm run test:all");
  const described = document.getElementById(
    row.getAttribute("aria-describedby") ?? "",
  );
  expect(described?.textContent).toBe("You allowed this for this session");
  expect(screen.queryByText(/Allowed ·/)).toBeNull();
});

test("what the agent changed in ticketd is a step row, verb first", async () => {
  await open(
    one({ id: "c1", title: "Limiter" }, [
      youSaid,
      turnTiming("completed", "2026-11-10T10:00:30Z"),
      inTurn({
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
          { kind: "update", reference: "T-12", excerpt: "Limiter is in" },
        ],
      }),
    ]),
  );
  fireEvent.click(button("Worked for 30s"));
  const body = screen.getByRole("group", { name: "Worked for 30s" });
  expect(body.textContent).toContain("Moved T-12 to In review");
  expect(body.textContent).toContain("Posted an update on T-12");
  expect(within(body).getAllByText("T-12")[0]?.dataset.slot).toBe("reference");
});

test("/ at the start of a message lists the harness's own commands", async () => {
  await open(
    one({
      id: "cmds",
      title: "Limiter",
      commands: [{ name: "review", description: "Review a pull request" }],
    }),
  );
  type("/rev");
  expect(await screen.findByText("Codex commands")).toBeTruthy();
  expect(screen.getByRole("option", { name: /review/ })).toBeTruthy();
});

test("a sent message keeps its mentions as links and its quotes as quotes", async () => {
  const t14 = {
    kind: "ticket" as const,
    id: "t14",
    reference: "T-14",
    title: "Show the remaining wait time",
    status: "Todo",
  };
  const doc = { kind: "document" as const, id: "d1", title: "Login spec" };
  await open(
    one(
      {
        id: "sent",
        title: "Limiter",
        links: [t14, doc],
        trashed_links: ["d1"],
      },
      [
        {
          ...youSaid,
          text: "> From T-12 · Description:\n> keep it short\n\nLook at T-14 and Login spec",
        },
      ],
    ),
  );
  const message = document.querySelector<HTMLElement>(".chat-you")!;
  expect(within(message).getByRole("button", { name: "T-14" })).toBeTruthy();
  expect(message.textContent).toContain("Login spec (in Trash)");
  expect(
    within(message).queryByRole("button", { name: "Login spec" }),
  ).toBeNull();
  const quote = message.querySelector("blockquote")!;
  expect(quote.textContent).toBe("T-12 · Descriptionkeep it short");
  expect(message.textContent).not.toContain("> From");
});

test("a receipt names a trashed or deleted record instead of linking it", async () => {
  await open(
    one({ id: "gone", title: "Limiter" }, [
      youSaid,
      turnTiming("completed", "2026-11-10T10:00:30Z"),
      inTurn({
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
          { kind: "update", reference: "T-13", excerpt: "Limiter is in" },
        ],
        gone: ["trashed", "deleted"],
      }),
    ]),
  );
  const row = document.querySelector<HTMLElement>(".chat-records")!;
  expect(row.textContent).toContain("Moved T-12 (in Trash) to In review");
  expect(row.textContent).toContain("Posted an update on T-13 (deleted)");
  expect(within(row).queryByRole("button", { name: "T-12" })).toBeNull();
});

test("a finished turn's record changes are one receipt row under it, whose more opens the fold", async () => {
  // Its own Chat: fold toggles are remembered by Chat for the session.
  await open(
    one({ id: "receipt", title: "Limiter" }, [
      youSaid,
      turnTiming("completed", "2026-11-10T10:00:30Z"),
      inTurn({
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
          { kind: "update", reference: "T-12", excerpt: "Limiter is in" },
          { kind: "document", document_id: "d9", title: "Reset email copy" },
        ],
      }),
    ]),
  );
  // Outside the folded turn: two sentences whose references open, then 1 more.
  expect(screen.queryByRole("group", { name: "Worked for 30s" })).toBeNull();
  expect(screen.getAllByRole("button", { name: "T-12" })).toHaveLength(2);
  expect(document.querySelector(".chat-records-items")?.textContent).toBe(
    "Moved T-12 to In review · Posted an update on T-12",
  );
  fireEvent.click(button("1 more"));
  expect(
    screen.getByRole("group", { name: "Worked for 30s" }).textContent,
  ).toContain("Created the Document Reset email copy");
});

/** Sizes a transcript as a browser would, which jsdom does not. */
function sized(scroller: HTMLElement, height: number, content: number) {
  Object.defineProperty(scroller, "clientHeight", {
    configurable: true,
    value: height,
  });
  Object.defineProperty(scroller, "scrollHeight", {
    configurable: true,
    value: content,
  });
}

test("scrolling up stops following; Jump to latest resumes it", async () => {
  await open(one({ id: "c1", title: "Limiter" }, [reply("r1", "Hello")]));
  const scroller = document.querySelector<HTMLElement>(".chat-scroll")!;
  const jump = document.querySelector<HTMLElement>(".chat-jump")!;
  // Following: the control is hidden and out of reach.
  expect(jump.hasAttribute("inert")).toBe(true);
  sized(scroller, 200, 1000);
  scroller.scrollTop = 800;
  fireEvent.scroll(scroller);
  // The reader's wheel, not just a smaller offset, stops following.
  fireEvent.wheel(scroller, { deltaY: -500 });
  scroller.scrollTop = 300;
  fireEvent.scroll(scroller);
  expect(jump.hasAttribute("inert")).toBe(false);
  fireEvent.click(within(jump).getByRole("button", { name: "Jump to latest" }));
  expect(scroller.scrollTop).toBe(1000);
  expect(jump.hasAttribute("inert")).toBe(true);
  // At the bottom again, scrolling there also resumes it.
  scroller.scrollTop = 300;
  fireEvent.scroll(scroller);
  scroller.scrollTop = 795;
  fireEvent.scroll(scroller);
  expect(jump.hasAttribute("inert")).toBe(true);
});

test("opening a row at the bottom keeps following; only scrolling up stops it", async () => {
  await open(
    one({ id: "c1", title: "Limiter" }, [
      youSaid,
      turnTiming("completed", "2026-11-10T10:02:13Z"),
      inTurn({ id: "s1", at, kind: "steps", steps: [failedRun] }),
      inTurn(reply("r1", "The limiter is in.")),
    ]),
  );
  const jump = document.querySelector<HTMLElement>(".chat-jump")!;
  fireEvent.click(button("Worked for 2m 13s · 1 failed"));
  expect(jump.hasAttribute("inert")).toBe(true);
});

test("what arrived while the Chat was not open is marked New, never your own message", async () => {
  // Everything in a window of this height counts as seen, and the window has focus.
  const height = vi
    .spyOn(HTMLElement.prototype, "clientHeight", "get")
    .mockReturnValue(600);
  const focused = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  try {
    const client = await open(
      one({ id: "c1", title: "Limiter" }, [youSaid, inTurn(reply("r1", "Hi"))]),
    );
    fireEvent.click(button("Close Chat"));
    client.push("c1", { ...youSaid, id: "u2", text: "And the IPs?" });
    client.push("c1", reply("r2", "Done for IPs too."));
    fireEvent.click(await screen.findByRole("button", { name: /^Limiter/ }));
    const marker = await screen.findByRole("separator", {
      name: "New since you left",
    });
    // The marker sits above the reply, not above your own message.
    const reply2 = conversation().getByText("Done for IPs too.");
    const you2 = conversation().getByText("And the IPs?");
    expect(
      marker.compareDocumentPosition(reply2) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      marker.compareDocumentPosition(you2) & Node.DOCUMENT_POSITION_PRECEDING,
    ).toBeTruthy();
    // It stays until the person sends.
    type("Thanks");
    fireEvent.click(button("Send"));
    await waitFor(() =>
      expect(
        screen.queryByRole("separator", { name: "New since you left" }),
      ).toBeNull(),
    );
  } finally {
    height.mockRestore();
    focused.mockRestore();
  }
});

test("the New marker follows the read-through position the host kept, also after a restart", async () => {
  // A Chat read through r1 in an earlier run of ticketd; this session never saw it.
  const client = await open(
    one({ id: "c1", title: "Limiter", read_through: "r1" }, [
      youSaid,
      inTurn(reply("r1", "Hi")),
      reply("r2", "Done for IPs too."),
    ]),
  );
  const marker = await screen.findByRole("separator", {
    name: "New since you left",
  });
  const reply2 = conversation().getByText("Done for IPs too.");
  expect(
    marker.compareDocumentPosition(reply2) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  // What comes into view in a focused window is kept with the Chat.
  const height = vi
    .spyOn(HTMLElement.prototype, "clientHeight", "get")
    .mockReturnValue(600);
  const focused = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  try {
    fireEvent.scroll(document.querySelector<HTMLElement>(".chat-scroll")!);
    await waitFor(() => expect(client.readThroughs.at(-1)).toBe("r2"));
  } finally {
    height.mockRestore();
    focused.mockRestore();
  }
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
  expect(await screen.findByText("Saved to Documents.")).toBeTruthy();
  expect(client.savedDocuments).toEqual(["Login rate limiter"]);
  // CH-33: the confirmation does not stay above the composer; sending clears it.
  type("Next step");
  fireEvent.click(button("Send"));
  await waitFor(() =>
    expect(screen.queryByText("Saved to Documents.")).toBeNull(),
  );
});

/** With no links there is no chip row: the Chat actions menu links one. */
const linkFromMenu = async () => {
  openMenu("Chat actions");
  fireEvent.click(
    await screen.findByRole("menuitem", {
      name: "Link a ticket, Document or Project…",
    }),
  );
};

test("records are linked by title and unlinked from their chip", async () => {
  await open(one({ id: "c1", title: "Limiter" }));
  expect(screen.queryByRole("group", { name: "Linked records" })).toBeNull();
  await linkFromMenu();
  fireEvent.change(
    await screen.findByLabelText(
      "Search tickets, Documents and Projects by title or reference",
    ),
    { target: { value: "wait" } },
  );
  fireEvent.click(await screen.findByRole("option", { name: /T-14/ }));
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
    expect(screen.queryByRole("group", { name: "Linked records" })).toBeNull(),
  );
});

test("Check again shows only while the harness isn't ready, and a failed recheck says so", async () => {
  const client = await open(one({ id: "c1", title: "Limiter" }));
  fireEvent.click(button(/^Folder web-app/));
  let popover = await screen.findByRole("dialog", { name: "Chat context" });
  expect(await within(popover).findByText("Signed in")).toBeTruthy();
  expect(
    within(popover).queryByRole("button", { name: "Check again" }),
  ).toBeNull();
  fireEvent.keyDown(popover, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  // Esc returns focus to the button that opened it.
  expect(document.activeElement).toBe(button(/^Folder web-app/));

  client.setHarnesses([
    { id: "codex", name: "Codex", status: "not_signed_in" },
  ]);
  fireEvent.click(button(/^Folder web-app/));
  popover = await screen.findByRole("dialog", { name: "Chat context" });
  expect(await within(popover).findByText("Not signed in")).toBeTruthy();
  client.harnesses = () => Promise.reject(new Error("probe failed"));
  fireEvent.click(within(popover).getByRole("button", { name: "Check again" }));
  expect(await within(popover).findByText("Couldn't check")).toBeTruthy();
  expect(within(popover).queryByText("Not signed in")).toBeNull();
});

test("a check that never answers reads as Couldn't check after a while", async () => {
  const client = await open(one({ id: "c1", title: "Limiter" }));
  client.harnesses = () => new Promise(() => {});
  vi.useFakeTimers();
  try {
    fireEvent.click(button(/^Folder web-app/));
    const popover = screen.getByRole("dialog", { name: "Chat context" });
    expect(within(popover).getByText("Checking…")).toBeTruthy();
    act(() => vi.advanceTimersByTime(8_000));
    expect(within(popover).getByText("Couldn't check")).toBeTruthy();
    expect(
      within(popover).getByRole("button", { name: "Check again" }),
    ).toHaveProperty("disabled", false);
  } finally {
    vi.useRealTimers();
  }
});

test("the context popover opens the other Chats here and the Project's tickets", async () => {
  const openProject = vi.fn();
  const client = await open(
    [
      ...one({
        id: "c1",
        title: "Limiter",
        folder: {
          shared_with: [
            { id: "c2", title: "Alert on-call", retention: "active" },
          ],
          project: { id: "p1", title: "Web App" },
        },
      }),
      ...one({ id: "c2", title: "Alert on-call" }),
    ],
    undefined,
    openProject,
  );
  void client;
  fireEvent.click(button(/^Folder web-app/));
  let popover = await screen.findByRole("dialog", { name: "Chat context" });
  fireEvent.click(
    within(popover).getByRole("button", { name: "Open tickets of Web App" }),
  );
  expect(openProject).toHaveBeenCalledWith("p1");
  popover = await screen.findByRole("dialog", { name: "Chat context" });
  // The other Chats show only when asked for.
  expect(
    within(popover).queryByRole("button", { name: "Alert on-call" }),
  ).toBeNull();
  fireEvent.click(
    within(popover).getByRole("button", { name: "1 other Chat here" }),
  );
  fireEvent.click(
    within(popover).getByRole("button", { name: "Alert on-call" }),
  );
  expect(
    await screen.findByRole("heading", { name: "Alert on-call" }),
  ).toBeTruthy();
});

test("the context popover holds the harness, folder, branch and the other Chats sharing the folder", async () => {
  const client = await open(
    one({
      id: "c1",
      title: "Limiter",
      harness: { permissions: "Uses your Codex settings." },
      folder: {
        shared_with: [
          { id: "c9", title: "Alert on-call", retention: "active" },
        ],
        branch: { kind: "branch", name: "rate-limit-logins" },
        project: { id: "p1", title: "Web App" },
      },
    }),
  );
  client.setHarnesses([
    {
      id: "codex",
      name: "Codex",
      status: "ready",
      version: "0.167.2",
      path: "/usr/local/bin/codex",
    },
  ]);
  const context = button(
    "Folder web-app, branch rate-limit-logins, Project Web App, used by 1 other Chat",
  );
  // Only the Project's letter tile and the folder: the rest is in the popover.
  expect(context.textContent).toBe("Wweb-app");
  fireEvent.click(context);
  const popover = await screen.findByRole("dialog", { name: "Chat context" });
  expect(await within(popover).findByText("Signed in")).toBeTruthy();
  expect(popover.textContent).toContain("0.167.2 · /usr/local/bin/codex");
  expect(popover.textContent).toContain("~/code/web-app");
  expect(popover.textContent).toContain("rate-limit-logins");
  expect(popover.textContent).toContain("1 other Chat here");
  expect(popover.textContent).toContain("Web App");
  // The harness's own settings sentence is #367's, not this popover's (#307).
  expect(popover.textContent).not.toContain("Uses your Codex settings.");
  fireEvent.click(within(popover).getByRole("button", { name: /^Open in / }));
  await waitFor(() => expect(client.openedFiles).toEqual(["~/code/web-app"]));
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
  expect(working()).toBe("Catching up…");
  expect(button("Stop")).toBeTruthy();
});

test("while its session opens the working line says so and counts, then reads as working", async () => {
  const client = await open(
    one({ id: "c1", title: "Limiter", activity: "working", opening: "resume" }),
  );
  expect(working()).toBe("Resuming the Codex session…");
  act(() => client.patch("c1", { opening: "start" }));
  expect(working()).toBe("Starting Codex…");
  act(() =>
    client.patch("c1", {
      opening: null,
      doing: { label: "Working", since: new Date().toISOString() },
    }),
  );
  // Under a second there is no clock yet.
  expect(working()).toBe("Working…");
});

test.each([
  { id: "codex", name: "Codex", command: "codex login" },
  { id: "claude-code", name: "Claude Code", command: "claude /login" },
])(
  "New Chat guides installation and sign-in for missing $name and keeps the draft",
  async ({ id, name, command }) => {
    const client = await open([]);
    client.setHarnesses([
      {
        id,
        name,
        status: "not_installed",
        command,
        help_url: "https://example.com/install",
      },
    ]);
    client.nextFolder = "~/code/web-app";
    fireEvent.click(await screen.findByRole("button", { name: "New Chat" }));
    expect(
      await screen.findByRole("heading", { name: "What should we work on?" }),
    ).toBeTruthy();
    type("Draft the reset email", "Describe a task or ask a question");
    expect(await screen.findByText(`${name} isn't installed`)).toBeTruthy();
    expect(screen.getByText(command)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      `Install it, then run ${command} in a terminal and sign in, then check again.`,
    );
    expect(button("Install guide")).toBeTruthy();
    expect(button("Copy command")).toBeTruthy();
    expect(button("Send")).toHaveProperty("disabled", true);
    const create = vi.spyOn(client, "createChat");
    fireEvent.click(button("Send"));
    expect(create).not.toHaveBeenCalled();

    fireEvent.click(button("Check again"));
    expect(await screen.findByText(`${name} isn't installed`)).toBeTruthy();
    expect(button("Send")).toHaveProperty("disabled", true);
    expect(composer("Describe a task or ask a question")).toHaveProperty(
      "value",
      "Draft the reset email",
    );

    client.setHarnesses([{ id, name, status: "ready" }]);
    fireEvent.click(button("Check again"));
    await waitFor(() =>
      expect(button("Send")).toHaveProperty("disabled", false),
    );
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
  },
);

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
  expect(screen.getByRole("alert").textContent).toContain("Storage failed.");

  // New Chat starts clean: a changed message is a new request, not a conflict.
  await newChat();
  expect(composer(describe)).toHaveProperty("value", "");
  await send("something else");
  await screen.findByText("Couldn't start the Chat.");
  expect(asked[1]?.command_id).not.toBe(asked[0]?.command_id);
  // Sending the very same request again repeats its id, so it finds what it made.
  expect(composer(describe)).toHaveProperty("value", "something else");
  fireEvent.click(button("Send"));
  await waitFor(() => expect(asked).toHaveLength(3));
  expect(asked[2]?.command_id).toBe(asked[1]?.command_id);
  // Changing what is asked for makes it a new request.
  await screen.findByText("Couldn't start the Chat.");
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
  await linkFromMenu();
  fireEvent.change(
    await screen.findByLabelText(
      "Search tickets, Documents and Projects by title or reference",
    ),
    { target: { value: "store" } },
  );
  fireEvent.click(await screen.findByRole("option", { name: /Storefront/ }));
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
  await waitFor(() =>
    expect(screen.queryByRole("group", { name: "Linked records" })).toBeNull(),
  );
});

test("a managed folder reads as the Scratch folder, and its popover says ticketd keeps it", async () => {
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
  expect(button("Folder Scratch folder").textContent).toBe("Scratch folder");
  expect(screen.getByRole("list", { name: "Chats" }).textContent).not.toContain(
    "f4f684bc",
  );
  fireEvent.click(button("Folder Scratch folder"));
  const popover = await screen.findByRole("dialog", { name: "Chat context" });
  // LIVE2-6: the scratch path means nothing to read; Copy path still gives it.
  expect(popover.textContent).toContain("Kept by ticketd for this Chat");
  expect(popover.textContent).not.toContain("workspace.sqlite3");
  expect(
    within(popover).getByRole("button", { name: "Copy path" }),
  ).toBeTruthy();
  // The popover takes focus itself, not its first button.
  expect(document.activeElement).toBe(popover);
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

test("the link picker lists recent records before a name is typed", async () => {
  await open(one({ id: "c1", title: "Limiter" }));
  await linkFromMenu();
  const recent = await screen.findByRole("group", { name: "Recent" });
  expect(
    within(recent).getByRole("option", { name: /Storefront/ }),
  ).toBeTruthy();
  expect(
    screen.queryByText("Type part of a name or a reference to find it."),
  ).toBeNull();
});

test("New Chat picks harness, model and effort in one composer picker and starts with them", async () => {
  localStorage.clear();
  const client = await open([]);
  client.setHarnesses([
    { id: "claude-code", name: "Claude Code", status: "ready" },
    {
      id: "codex",
      name: "Codex",
      status: "not_signed_in",
      command: "codex login",
    },
  ]);
  fireEvent.click(await screen.findByRole("button", { name: "New Chat" }));
  // No radios: the harness is the picker's, beside Send.
  const trigger = await screen.findByRole("button", {
    name: "Claude Code, model Opus 5.5, effort Default",
  });
  expect(screen.queryByRole("radiogroup", { name: "Harness" })).toBeNull();
  fireEvent.click(trigger);
  const tabs = await screen.findByRole("tablist", { name: "Harness" });
  // A harness that isn't ready is dimmed with its word.
  expect(
    within(tabs).getByRole("tab", { name: /Codex.*Not signed in/ }),
  ).toBeTruthy();
  fireEvent.click(await screen.findByRole("radio", { name: /^Sonnet 5/ }));
  fireEvent.click(await screen.findByRole("radio", { name: "High" }));
  expect(
    screen.getByRole("button", {
      name: "Claude Code, model Sonnet 5, effort High",
    }),
  ).toBeTruthy();
  // Permissions names the mode it starts in.
  expect(button("Permissions: Ask before edits")).toBeTruthy();
  type("Add a limiter", "Describe a task or ask a question");
  fireEvent.click(button("Send"));

  await waitFor(() =>
    expect(client.created.at(-1)).toMatchObject({
      harness_id: "claude-code",
      model: "sonnet",
      effort: "high",
      permission: "default",
    }),
  );
});

test("New Chat starts with the model and effort its picker shows, even when they were already selected", async () => {
  // LIVE-7: the picker showed Codex's listed default, and choosing the row that
  // was already checked changed nothing, so nothing was sent and Codex ran its
  // own configuration's model at Max.
  localStorage.clear();
  const client = await open([]);
  client.setHarnesses([{ id: "codex", name: "Codex", status: "ready" }]);
  fireEvent.click(await screen.findByRole("button", { name: "New Chat" }));
  const trigger = await screen.findByRole("button", {
    name: "Codex, model GPT-5.5 Codex, effort Medium",
  });
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole("radio", { name: /^GPT-5.5 Codex/ }));
  fireEvent.click(await screen.findByRole("radio", { name: "Medium" }));
  type("Add a limiter", "Describe a task or ask a question");
  fireEvent.click(button("Send"));

  await waitFor(() =>
    expect(client.created.at(-1)).toMatchObject({
      harness_id: "codex",
      model: "gpt-5.5-codex",
      effort: "medium",
    }),
  );
});

test("a sent message starts its turn at once: one Starting line, and the composer is already running", async () => {
  await open(
    one({ id: "c1", title: "Limiter" }, [
      {
        id: "u1",
        at,
        kind: "user",
        text: "Add a rate limiter",
        delivery: "sending",
      },
    ]),
  );
  // Before the host reports the turn, the view already shows it starting.
  expect(working()).toBe("Starting Codex…");
  expect(screen.queryByText("Sending…")).toBeNull();
  expect(button("Steer")).toBeTruthy();
  // Stop waits until the host knows of the turn.
  expect(button("Stop")).toHaveProperty("disabled", true);
});

test("a Chat started in New Chat keeps its picks on the triggers until the session reports", async () => {
  localStorage.clear();
  const client = await open([]);
  client.setHarnesses([
    { id: "claude-code", name: "Claude Code", status: "ready" },
  ]);
  fireEvent.click(await screen.findByRole("button", { name: "New Chat" }));
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Claude Code, model Opus 5.5, effort Default",
    }),
  );
  fireEvent.click(await screen.findByRole("radio", { name: /^Sonnet 5/ }));
  fireEvent.click(await screen.findByRole("radio", { name: "High" }));
  type("Add a limiter", "Describe a task or ask a question");
  fireEvent.click(button("Send"));

  // The mock's Chat has no session settings yet: the triggers show the start.
  await screen.findByRole("heading", { name: "Add a limiter" });
  expect(
    await screen.findByRole("button", {
      name: "Claude Code, model Sonnet 5, effort High",
    }),
  ).toBeTruthy();
  expect(button("Permissions: Ask before edits")).toBeTruthy();
});

test("the picker keeps the default and the latest models, moves between harnesses with arrows", async () => {
  localStorage.clear();
  const client = await open([]);
  const many = Array.from({ length: 9 }, (_, index) => ({
    id: `m${index}`,
    label: `Model ${index}`,
    description: `Model ${index} model.`,
    is_default: index === 0,
    allowed: true,
    efforts: [],
  }));
  client.options.set("codex", { harness_id: "codex", models: many });
  client.setHarnesses([
    { id: "claude-code", name: "Claude Code", status: "ready" },
    { id: "codex", name: "Codex", status: "ready" },
  ]);
  localStorage.setItem("ticketd.chat-harness", "codex");
  fireEvent.click(await screen.findByRole("button", { name: "New Chat" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Codex, model Model 0" }),
  );
  expect(await screen.findAllByRole("radio", { name: /^Model / })).toHaveLength(
    6,
  );
  // A description that only repeats the name is dropped.
  expect(screen.queryByText("Model 1 model.")).toBeNull();
  fireEvent.click(button("More models (3)"));
  expect(screen.getAllByRole("radio", { name: /^Model / })).toHaveLength(9);

  const codex = screen.getByRole("tab", { name: "Codex" });
  codex.focus();
  fireEvent.keyDown(codex, { key: "ArrowLeft" });
  const claude = screen.getByRole("tab", { name: "Claude Code" });
  expect(document.activeElement).toBe(claude);
  expect(claude.getAttribute("aria-selected")).toBe("true");
  expect(
    await screen.findByRole("button", { name: /^Claude Code, model Opus 5.5/ }),
  ).toBeTruthy();
  localStorage.clear();
});

test("LIVE2-4: only the harness's default is tagged Default, and only once", async () => {
  localStorage.clear();
  const client = await open([]);
  const row = (id: string, label: string, more = {}) => ({
    id,
    label,
    is_default: false,
    allowed: true,
    efforts: [],
    ...more,
  });
  client.options.set("claude-code", {
    harness_id: "claude-code",
    models: [
      row("default", "Default (recommended)", {
        is_default: true,
        description: "For your toughest challenges",
      }),
      row("fable", "fable", { runs_as: "Fable 5.2" }),
      row("opus", "Opus 5.5"),
    ],
  });
  client.setHarnesses([
    { id: "claude-code", name: "Claude Code", status: "ready" },
  ]);
  fireEvent.click(await screen.findByRole("button", { name: "New Chat" }));
  fireEvent.click(
    await screen.findByRole("button", { name: /^Claude Code, model/ }),
  );
  const radios = await screen.findAllByRole("radio", {
    name: /Default|Fable|Opus/,
  });
  expect(radios.map((radio) => radio.textContent)).toEqual([
    "DefaultFor your toughest challenges",
    "Fable 5.2",
    "Opus 5.5",
  ]);
  localStorage.clear();
});

test("linking a Project with a folder in New Chat starts the Chat there", async () => {
  localStorage.clear();
  const client = await open([]);
  client.projectFolders.set("p1", "/work/storefront");
  fireEvent.click(await screen.findByRole("button", { name: "New Chat" }));
  expect(button("Scratch folder")).toBeTruthy();
  fireEvent.click(button("Link a ticket, Document or Project"));
  // Recent records show before anything is typed.
  expect(await screen.findByRole("group", { name: "Recent" })).toBeTruthy();
  fireEvent.click(await screen.findByRole("option", { name: /Storefront/ }));
  expect(
    await screen.findByRole("button", { name: "Folder: /work/storefront" }),
  ).toBeTruthy();
});

test("New Chat on Claude Code sends the shown default model and permission mode, untouched", async () => {
  localStorage.clear();
  const client = await open([]);
  client.setHarnesses([
    { id: "claude-code", name: "Claude Code", status: "ready" },
  ]);
  fireEvent.click(await screen.findByRole("button", { name: "New Chat" }));
  await screen.findByRole("button", {
    name: "Claude Code, model Opus 5.5, effort Default",
  });
  // The permission trigger names the mode, not "Default".
  expect(button("Permissions: Ask before edits")).toBeTruthy();
  type("Add a limiter", "Describe a task or ask a question");
  fireEvent.click(button("Send"));

  await waitFor(() =>
    expect(client.created.at(-1)).toMatchObject({
      harness_id: "claude-code",
      model: "default",
      permission: "default",
    }),
  );
  // Its default model names no default effort: Claude Code's own applies.
  expect(client.created.at(-1)).not.toHaveProperty("effort");
});

test("New Chat starts on the first harness that can be used, not the one called ready", async () => {
  localStorage.clear();
  const client = await open([]);
  client.setHarnesses([
    { id: "claude-code", name: "Claude Code", status: "sign_in_unknown" },
    { id: "codex", name: "Codex", status: "ready" },
  ]);
  fireEvent.click(await screen.findByRole("button", { name: "New Chat" }));
  expect(
    await screen.findByRole("button", { name: /^Claude Code, model/ }),
  ).toBeTruthy();
});

test("New Chat starts from the harness's last pick and switching harness shows its fix", async () => {
  localStorage.setItem(
    "ticketd.chat-picks",
    JSON.stringify({
      "claude-code": { model: "haiku", effort: null, permission: "plan" },
    }),
  );
  const client = await open([]);
  client.setHarnesses([
    { id: "claude-code", name: "Claude Code", status: "ready" },
    {
      id: "codex",
      name: "Codex",
      status: "not_signed_in",
      command: "codex login",
    },
  ]);
  fireEvent.click(await screen.findByRole("button", { name: "New Chat" }));
  const trigger = await screen.findByRole("button", {
    name: "Claude Code, model Haiku 4.5",
  });
  expect(button("Permissions: Plan only")).toBeTruthy();
  fireEvent.click(trigger);
  fireEvent.click(
    within(await screen.findByRole("tablist", { name: "Harness" })).getByRole(
      "tab",
      { name: /Codex/ },
    ),
  );
  // Its notice holds the fix, once: in the picker while it is open.
  expect(
    await screen.findAllByRole("button", { name: "Copy command" }),
  ).toHaveLength(1);
  localStorage.clear();
});

const option = (id: string, label: string, is_default = false) => ({
  id,
  label,
  is_default,
  allowed: true,
});

test("a Chat's picker changes model on its own harness; a refusal is one dock line", async () => {
  const client = await open(
    one({
      id: "c1",
      title: "Limiter",
      harness: { id: "claude-code", name: "Claude Code" },
      settings: {
        model: {
          current: "opus",
          options: [
            option("opus", "Opus 5.5", true),
            option("sonnet", "Sonnet 5"),
          ],
          changeable: true,
          applies_from: "next_turn",
        },
        effort: {
          current: "high",
          options: [
            option("low", "Low"),
            option("medium", "Medium"),
            option("high", "High", true),
            option("max", "Max"),
          ],
          changeable: true,
          applies_from: "next_turn",
        },
        permission: {
          current: "accept_edits",
          options: [
            option("ask", "Ask before edits", true),
            option("accept_edits", "Accept edits"),
          ],
          changeable: true,
          applies_from: "next_turn",
        },
      },
    }),
  );
  const asked: string[] = [];
  client.changeSetting = async (_id, setting, value) => {
    asked.push(`${setting}=${value}`);
    return {
      value,
      state: "refused",
      reason: "it isn't available on your plan",
    };
  };
  const picker = "Claude Code, model Opus 5.5, effort High";
  // The effort's word stands beside its bars.
  expect(button(picker).textContent).toBe("Opus 5.5High");
  expect(button("Permissions: Accept edits").textContent).toBe("Accept edits");

  fireEvent.click(button(picker));
  expect(
    await screen.findByText("Applies from your next message."),
  ).toBeTruthy();
  // A Chat keeps its harness: only its own tab shows.
  expect(screen.getByRole("tab", { name: "Claude Code" })).toBeTruthy();
  expect(screen.queryByRole("tab", { name: "Codex" })).toBeNull();
  fireEvent.click(await screen.findByRole("radio", { name: /^Sonnet 5/ }));
  fireEvent.keyDown(document.activeElement ?? document.body, {
    key: "Escape",
  });
  expect(
    await screen.findByText(
      "Claude Code didn't switch to Sonnet 5: it isn't available on your plan.",
    ),
  ).toBeTruthy();
  // The value in effect stays on the trigger.
  expect(button(picker)).toBeTruthy();

  openMenu("Permissions: Accept edits");
  expect(await screen.findByText(/^This Chat only\./)).toBeTruthy();
  expect(
    screen.queryByRole("menuitemradio", { name: /Full access/ }),
  ).toBeNull();
  fireEvent.click(
    await screen.findByRole("menuitemradio", { name: /^Ask before edits/ }),
  );
  await waitFor(() =>
    expect(asked).toEqual(["model=sonnet", "permission=ask"]),
  );
});

test("a change held for the turn's end shows the new value with a clock, never squeezing it", async () => {
  await open(
    one({
      id: "held",
      title: "Limiter",
      activity: "working",
      harness: { id: "codex", name: "Codex" },
      settings: {
        model: {
          current: "opus",
          options: [
            option("opus", "Opus 5.5", true),
            option("sonnet", "Sonnet 5"),
          ],
          changeable: true,
          applies_from: "next_request",
          change: { value: "sonnet", state: "held" },
        },
      },
    }),
  );
  const trigger = button("Codex, model Sonnet 5, from your next message");
  expect(trigger.textContent).toBe("Sonnet 5");
  expect(trigger.querySelector(".chat-spin")).toBeNull();
  // Marked by a clock, not by words beside the trigger (CH-19).
  expect(trigger.querySelector(".chat-control-held")).not.toBeNull();
  expect(screen.queryByText(/from your next message/i)).toBeNull();
  fireEvent.click(trigger);
  expect(
    await screen.findByText("Applies from your next message."),
  ).toBeTruthy();
  expect(screen.queryByText("From the next request")).toBeNull();
});

test("before its session reports, a Chat's picker shows its harness and says why there is no choice", async () => {
  // Not made in New Chat during this run, so no start of its own to show.
  await open(one({ id: "reopened", title: "Limiter" }));
  fireEvent.click(button("Codex, model Default"));
  expect(
    await screen.findByText(
      "Codex lists its models once the Chat's session starts.",
    ),
  ).toBeTruthy();
  noButton(/^Permissions/);
});

test("LIVE-4: a ticketd approval says what it does, names the Project, and shows the exact command on request", async () => {
  const exact = "/Users/me/ticketd/target/debug/ticketd project show p1";
  await open(
    one(
      {
        id: "c1",
        title: "Limiter",
        activity: "waiting",
        links: [{ kind: "project", id: "p1", title: "Storefront" }],
      },
      [
        {
          ...approval,
          title: "Codex wants to",
          subject: "ticketd project show p1",
          command: exact,
          ticketd: [
            {
              verb: "read",
              words: [{ text: "Project" }, { text: "p1", record: "project" }],
            },
          ],
        },
      ],
    ),
  );
  const request = screen.getByRole("group", {
    name: "Codex wants to read Project Storefront",
  });
  expect(request.textContent).not.toContain("/Users/me");
  fireEvent.click(within(request).getByRole("button", { name: "Command" }));
  expect(within(request).getByText(exact)).toBeTruthy();
});

test("MOTION-14: the list is one Tab stop; arrows move between rows and to a row's actions", async () => {
  await open([
    { chat: chatState({ id: "c1", title: "First" }) },
    { chat: chatState({ id: "c2", title: "Second" }) },
  ]);
  const rows = Array.from(document.querySelectorAll<HTMLElement>(".chat-row"));
  expect(rows.map((row) => row.tabIndex)).toEqual([0, -1]);
  expect(
    document.querySelector<HTMLElement>(".chat-row-more button")?.tabIndex,
  ).toBe(-1);
  rows[0]!.focus();
  fireEvent.keyDown(rows[0]!, { key: "ArrowDown" });
  expect(document.activeElement).toBe(rows[1]);
  fireEvent.keyDown(rows[1]!, { key: "ArrowRight" });
  expect(document.activeElement?.getAttribute("aria-label")).toBe(
    "Actions for Second",
  );
});

test("CH-12: Expand keeps New Chat's links and harness check, and the list stays mounted", async () => {
  localStorage.clear();
  const client = await open([]);
  client.projectFolders.set("p1", "/work/storefront");
  fireEvent.click(await screen.findByRole("button", { name: "New Chat" }));
  fireEvent.click(button("Link a ticket, Document or Project"));
  fireEvent.click(await screen.findByRole("option", { name: /Storefront/ }));
  const linked = () =>
    screen.queryByRole("button", {
      name: "Remove the link to the Project Storefront",
    });
  const folder = () =>
    screen.queryByRole("button", { name: "Folder: /work/storefront" });
  await waitFor(() => expect(folder()).not.toBeNull());
  expect(linked()).not.toBeNull();
  const probes = vi.spyOn(client, "harnesses");
  const pane = document.querySelector(".chat-new");
  const list = document.querySelector(".chat-rows");
  fireEvent.click(button("Expand Chat"));
  // The same New Chat, not a remount: its links stay and no second check runs.
  expect(document.querySelector(".chat-new")).toBe(pane);
  expect(linked()).not.toBeNull();
  expect(folder()).not.toBeNull();
  expect(probes).not.toHaveBeenCalled();
  expect(
    document.querySelector(".chats-workspace")?.getAttribute("data-single"),
  ).toBe("detail");
  fireEvent.click(button("Show beside the list"));
  expect(document.querySelector(".chat-new")).toBe(pane);
  expect(document.querySelector(".chat-rows")).toBe(list);
  expect(linked()).not.toBeNull();
});

test("the notice, the request and the message box are one tray; options carry no number badge", async () => {
  await open(
    one(
      {
        id: "c1",
        title: "Limiter",
        activity: "waiting",
        problem: { kind: "usage_limit", past: true },
      },
      [question],
    ),
  );
  const request = await screen.findByRole("group", {
    name: /Redis is unreachable/,
  });
  const tray = request.closest<HTMLElement>(".chat-tray")!;
  expect(tray).not.toBeNull();
  expect(within(tray).getByText(/^It didn't say when it resets/)).toBeTruthy();
  expect(within(tray).getByLabelText(/^Answer/)).toBeTruthy();
  // It needs the person, so its title wears the attention dot (CH-35).
  expect(
    within(tray).getByRole("alert").querySelector('[data-slot="status-dot"]'),
  ).not.toBeNull();
  const option = within(tray).getByRole("button", { name: /^Fail open/ });
  expect(option.textContent).toBe(
    "Fail openLet logins through and log a warning",
  );
  expect(option.getAttribute("aria-keyshortcuts")).toBe("1");
});

test("with no Chat open the detail pane is New Chat, and the pencil keeps its draft", async () => {
  await open(one({ id: "c1", title: "Limiter" }));
  fireEvent.click(button("Close Chat"));
  expect(
    await screen.findByRole("heading", { name: "What should we work on?" }),
  ).toBeTruthy();
  // Resting, it has nothing to close and leaves focus on the closed Chat's row.
  noButton("Close New Chat");
  expect(document.activeElement).toBe(button(/^Limiter/));
  type("Draft the reset email", "Describe a task or ask a question");
  fireEvent.click(button("New Chat"));
  const box = composer("Describe a task or ask a question");
  expect(box).toHaveProperty("value", "Draft the reset email");
  await waitFor(() => expect(document.activeElement).toBe(box));
});
