import { revealFailureDetails } from "@/test/failure-details";
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
import userEvent from "@testing-library/user-event";
import {
  ChatClientContext,
  type HarnessSetting,
  type LinkedRecord,
  type Step,
  type TranscriptItem,
} from "@/features/chats/client";
import { ChatProvider } from "@/features/chats/ChatProvider";
import { ChatsView } from "@/features/chats/ChatsView";
import { StatusLineRegion } from "@/components/ui/status-line";
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
  vi.useRealTimers();
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
          <StatusLineRegion>
            <ChatsView />
          </StatusLineRegion>
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
  expect(queueHead("Queued 1 · After this turn")).toBeTruthy();

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
  expect(queueHead(/^Queued \d+ · Paused$/)).toBeTruthy();
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

test("Antigravity approval warnings stay with their choices when an answer needs retry", async () => {
  const reason = "Review the command before approving.";
  const allowWarning = "Adds a rule to always allow this command.";
  const denyWarning = "Adds a rule to always deny this command.";
  const options = [
    { id: "once", label: "Allow once" },
    { id: "provider-option-7", label: "Allow always", warning: allowWarning },
    { id: "provider-option-9", label: "Deny always", warning: denyWarning },
  ];
  const client = await open(
    one(
      {
        id: "c1",
        title: "Fixture Chat",
        activity: "waiting",
        harness: { id: "antigravity", name: "Antigravity" },
      },
      [{ ...approval, title: "Antigravity wants to run", reason, options }],
    ),
  );
  const request = screen.getByRole("group", {
    name: /^Antigravity wants to run/,
    description: reason,
  });
  const answer = vi
    .spyOn(client, "answer")
    .mockRejectedValueOnce(new Error("Disconnected"));
  const choices = within(request);
  const seeWarnings = () => {
    expect(choices.getByText(allowWarning)).toBeTruthy();
    expect(choices.getByText(denyWarning)).toBeTruthy();
    expect(
      choices.getByRole("button", { name: "Allow once", description: /^$/ }),
    ).toBeTruthy();
    expect(
      choices.getByRole("button", {
        name: "Deny always",
        description: denyWarning,
      }),
    ).toBeTruthy();
    return choices.getByRole("button", {
      name: "Allow always",
      description: allowWarning,
    });
  };

  expect(answer).not.toHaveBeenCalled();
  fireEvent.click(seeWarnings());
  expect(await choices.findByText("Pick again to retry.")).toBeTruthy();
  fireEvent.click(seeWarnings());
  await waitFor(() =>
    expect(
      screen.queryByRole("group", { name: /^Antigravity wants to run/ }),
    ).toBeNull(),
  );
  expect(answer.mock.calls).toEqual([
    ["c1", "req-1", { option_id: "provider-option-7" }],
    ["c1", "req-1", { option_id: "provider-option-7" }],
  ]);
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
        message: "helper_unknown_error: setup refresh had errors",
        help_url: "https://example.com/sandbox",
      },
    }),
  );
  const sandbox = await screen.findByText("Codex can't run commands here");
  expect(sandbox.closest("[data-tone]")?.getAttribute("data-tone")).toBe(
    "error",
  );
  // #387 M18: the harness's message ends as a sentence before ticketd's.
  expect(sandbox.parentElement?.textContent).toContain(
    "setup refresh had errors. ticketd won't lower its permissions",
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

test.each(["Checkout", "Choose a folder…"])(
  "a missing folder keeps the Chat readable and can be replaced via %s",
  async (choice) => {
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
    expect(button("Folder reset-email, missing").textContent).toBe(
      "reset-email",
    );
    // The path reads like the folder popover's: one line, not a code block.
    const notice = screen.getByRole("alert");
    expect(notice.querySelector('[data-slot="path-text"]')?.textContent).toBe(
      "~/ticketd/chats/reset-email",
    );
    expect(notice.querySelector("code")).toBeNull();
    expect(notice.textContent).toContain("wasn't found. Nothing was re-run.");
    const path = "/work/emails";
    if (choice === "Checkout") {
      client.projectCheckouts = [
        {
          project: { id: "missing", title: "Missing checkout" },
          path: "~/ticketd/chats/reset-email",
        },
        { project: { id: "p1", title: "Checkout" }, path },
      ];
    }
    client.nextFolder = path;
    const browse = vi.spyOn(client, "pickFolder");
    fireEvent.keyDown(button("Choose a folder…"), { key: "Enter" });
    const replacement = await screen.findByRole("menuitem", {
      name: choice === "Checkout" ? "Checkout /work/emails" : choice,
    });
    expect(
      screen.queryByRole("menuitem", { name: /Missing checkout/ }),
    ).toBeNull();
    fireEvent.click(replacement);
    expect(browse).toHaveBeenCalledTimes(choice === "Checkout" ? 0 : 1);
    expect(await screen.findByLabelText("Message Codex")).toBeTruthy();
    expect(button("Folder emails").textContent).toBe("emails");
  },
);

const nativeHistoryLost = {
  id: "c1",
  title: "Limiter",
  harness: { id: "antigravity", name: "Antigravity" },
  activity: "failed",
  problem: { kind: "history_lost", history_recovery: "start_fresh" },
} as const;

test("starting a native-only Chat fresh focuses its composer when it opens without importing past messages", async () => {
  const user = userEvent.setup();
  const client = await open(
    one(nativeHistoryLost, [reply("r1", "Added the limiter.")]),
  );
  const notice = screen.getByRole("alert");
  expect(notice.textContent).toContain("without importing earlier messages");
  expect(screen.queryByLabelText("Message Antigravity")).toBeNull();
  noButton("Resume in a fresh session…");
  const publishFreshSession = client.resume.bind(client);
  let confirmResume!: () => void;
  const pendingResume = new Promise<void>((resolve) => {
    confirmResume = resolve;
  });
  const resume = vi.spyOn(client, "resume").mockReturnValueOnce(pendingResume);
  const start = within(notice).getByRole("button", { name: "Start fresh" });
  act(() => start.focus());
  await user.keyboard("{Enter}");
  expect(resume).toHaveBeenCalledWith("c1", { kind: "none" });

  await act(async () => confirmResume());
  expect(document.activeElement).toBe(start);
  expect(screen.queryByLabelText("Message Antigravity")).toBeNull();

  await act(() => publishFreshSession("c1", { kind: "none" }));
  const message = await screen.findByLabelText("Message Antigravity");
  expect(document.activeElement).toBe(message);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(conversation().getByText("Added the limiter.")).toBeTruthy();
  expect(
    screen.getByText("Fresh session · no earlier messages imported"),
  ).toBeTruthy();
  expect(
    (await client.openChat("c1")).items.some((item) => item.kind === "user"),
  ).toBe(false);
});

test("a fresh session preserves focus moved elsewhere while recovery is pending", async () => {
  const user = userEvent.setup();
  const client = await open(
    one({
      ...nativeHistoryLost,
      activity: "idle",
      problem: null,
      queue_paused: true,
      queue: [{ id: "q1", text: "Add a regression test." }],
    }),
  );
  fireEvent.click(button("Edit in the message box"));
  await waitFor(() =>
    expect(composer("Message Antigravity")).toHaveProperty(
      "value",
      "Add a regression test.",
    ),
  );
  act(() =>
    client.patch("c1", {
      activity: nativeHistoryLost.activity,
      problem: nativeHistoryLost.problem,
    }),
  );

  const publishFreshSession = client.resume.bind(client);
  let confirmResume!: () => void;
  const pendingResume = new Promise<void>((resolve) => {
    confirmResume = resolve;
  });
  vi.spyOn(client, "resume").mockReturnValueOnce(pendingResume);
  act(() => button("Start fresh").focus());
  await user.keyboard("{Enter}");
  const other = button("Expand Chat");
  act(() => other.focus());

  await act(() => publishFreshSession("c1", { kind: "none" }));
  expect(composer("Message Antigravity")).toHaveProperty(
    "value",
    "Add a regression test.",
  );
  expect(document.activeElement).toBe(other);
  await act(async () => confirmResume());
  expect(document.activeElement).toBe(other);
});

test("a failed fresh session keeps the recovery action focused and shows the failure", async () => {
  const user = userEvent.setup();
  const client = await open(one(nativeHistoryLost));
  vi.spyOn(client, "resume").mockRejectedValueOnce(
    new Error("Session refused"),
  );
  const start = button("Start fresh");
  act(() => start.focus());
  await user.keyboard("{Enter}");

  const failure = await screen.findByText("Couldn't start a fresh session.");
  expect(failure.closest('[role="alert"]')).toBeTruthy();
  expect(document.activeElement).toBe(start);
  expect(screen.queryByLabelText("Message Antigravity")).toBeNull();
});

test.each([
  { id: "codex", name: "Codex" },
  { id: "claude-code", name: "Claude Code" },
])(
  "$name resumes the same Chat in a fresh session with chosen history",
  async (harness) => {
    const client = await open(
      one(
        {
          id: "c1",
          title: "Limiter",
          harness,
          activity: "failed",
          problem: { kind: "history_lost", history_recovery: "select_history" },
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
    expect(screen.queryByLabelText(`Message ${harness.name}`)).toBeNull();
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
    expect(
      await screen.findByLabelText(`Message ${harness.name}`),
    ).toBeTruthy();
    // Nothing was sent on the person's behalf.
    const { items } = await client.openChat("c1");
    expect(items.filter((item) => item.kind === "user")).toHaveLength(1);
  },
);

test("picking messages turns the transcript into the history picker", async () => {
  await open(
    one(
      {
        id: "c1",
        title: "Limiter",
        activity: "failed",
        problem: { kind: "history_lost", history_recovery: "select_history" },
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
  expect(
    await screen.findByText(
      "Pick the messages to give the new session · 0 of 2",
    ),
  ).toBeTruthy();
  expect(button("Resume")).toHaveProperty("disabled", true);
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: "Include the reply: Added the limiter.",
    }),
  );
  expect(
    screen.getByText("Pick the messages to give the new session · 1 of 2"),
  ).toBeTruthy();
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

const demoTicket = {
  kind: "ticket" as const,
  id: "t12",
  reference: "T-12",
  title: "Design the attachment review",
  status: "In progress",
};

test("a linked ticket whose title is the Chat's title shows its reference alone", async () => {
  await open(
    one({
      id: "c1",
      title: "Design the attachment review",
      links: [demoTicket],
    }),
  );
  const linked = within(screen.getByRole("group", { name: "Linked records" }));
  const chip = linked.getByRole("button", { name: /^Open T-12/ });
  expect(chip.textContent).toBe("T-12");
});

test("a linked ticket with another title keeps its title on the chip", async () => {
  await open(one({ id: "c1", title: "Limiter", links: [demoTicket] }));
  const chip = within(
    screen.getByRole("group", { name: "Linked records" }),
  ).getByRole("button", { name: /^Open T-12/ });
  expect(chip.textContent).toBe("T-12Design the attachment review");
});

test("the header says the full title in a tooltip only while the title is cut", async () => {
  const title = "A title long enough that the header has to cut it short";
  await open(one({ id: "c1", title }));
  const heading = screen.getByRole("heading", { name: title });
  const measure = (cut: boolean) => {
    Object.defineProperty(heading, "scrollWidth", {
      configurable: true,
      value: cut ? 400 : 100,
    });
    Object.defineProperty(heading, "clientWidth", {
      configurable: true,
      value: 200,
    });
    Object.defineProperty(heading, "scrollHeight", {
      configurable: true,
      value: 20,
    });
    Object.defineProperty(heading, "clientHeight", {
      configurable: true,
      value: 20,
    });
  };
  measure(false);
  await userEvent.hover(heading);
  expect(await screen.queryByRole("tooltip")).toBeNull();
  await userEvent.unhover(heading);
  measure(true);
  await userEvent.hover(heading);
  const tip = await screen.findByRole("tooltip");
  expect(tip.textContent).toBe(title);
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
  await revealFailureDetails();
  expect(await screen.findByText("The workspace is read-only.")).toBeTruthy();
});

test("a clicked notification focuses the request title and accepts its numbered answer", async () => {
  const user = userEvent.setup();
  const client = await open([
    ...one({ id: "c1", title: "Limiter", activity: "waiting" }, [approval]),
    ...one({ id: "c2", title: "Other" }),
  ]);
  fireEvent.click(await screen.findByRole("button", { name: /^Other/ }));
  act(() => client.requestOpen({ chat_id: "c1", retention: "active" }));
  const title = await screen.findByRole("heading", { name: /wants to run/ });
  await waitFor(() => expect(document.activeElement).toBe(title));
  await user.keyboard("2");
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull(),
  );
  expect((await client.openChat("c1")).items).toContainEqual(
    expect.objectContaining({
      id: "req-1",
      state: "answered",
      outcome: 'You chose "Allow for this session"',
    }),
  );
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
  // Each streamed chunk is a span of its own, so read the whole reply.
  await waitFor(() =>
    expect(document.querySelector(".chat-ai")?.textContent).toContain(
      "Reading the spec, then the tests, then writing.",
    ),
  );
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
  await waitFor(() =>
    expect(
      [...document.querySelectorAll(".chat-ai")].some((reply) =>
        reply.textContent?.endsWith(expected),
      ),
    ).toBe(true),
  );
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

test("Antigravity's native quota diagnostic is shown once with both failure statuses", async () => {
  const diagnostic =
    "\n⚠ agent executor error: generating and executing: Error 429, Message: Synthetic fixture quota exhausted for this test., Status: RESOURCE_EXHAUSTED, Details: []\n";
  const client = await open(
    one(
      {
        id: "c1",
        title: "Native quota failure",
        harness: { id: "antigravity", name: "Antigravity" },
        activity: "failed",
        problem: {
          kind: "usage_limit",
          past: true,
          message: diagnostic,
          resets_at: null,
        },
      },
      [
        { ...youSaid, text: "QA566_QUOTA_FINAL_STATUS" },
        turnTiming("failed", "2026-11-10T10:00:01Z"),
        inTurn(reply("r1", diagnostic)),
        inTurn({
          id: "t1",
          at: "2026-11-10T10:00:01Z",
          kind: "marker",
          reason: "failed",
          message: diagnostic,
        }),
      ],
    ),
  );

  const notice = screen.getByRole("alert");
  const pane = notice.closest(".chat-body");
  expect(pane?.textContent?.split(diagnostic.trim())).toHaveLength(2);
  expect(conversation().getByText(diagnostic.trim())).toBeTruthy();
  expect(
    conversation().getByText(
      "This turn failed. What it finished before that is kept.",
    ),
  ).toBeTruthy();
  expect(notice.textContent).toContain("Antigravity reached your usage limit");
  expect(notice.textContent).toContain("It didn't say when it resets.");

  act(() => client.patch("c1", { activity: "idle", problem: null }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(pane?.textContent?.split(diagnostic.trim())).toHaveLength(2);
});

test.each([
  { id: "antigravity", name: "Antigravity" },
  { id: "codex", name: "Codex" },
])(
  "$name keeps distinct assistant text, turn failure detail and usage-limit detail",
  async (harness) => {
    await open(
      one(
        {
          id: "c1",
          title: "Quota failure with partial work",
          harness,
          activity: "failed",
          problem: {
            kind: "usage_limit",
            past: true,
            message: "The account's usage limit was reached",
          },
        },
        [
          youSaid,
          turnTiming("failed", "2026-11-10T10:00:01Z"),
          inTurn(reply("r1", "I finished the draft.")),
          inTurn({
            id: "t1",
            at: "2026-11-10T10:00:01Z",
            kind: "marker",
            reason: "failed",
            message: "The harness could not run the final check",
          }),
        ],
      ),
    );

    expect(conversation().getByText("I finished the draft.")).toBeTruthy();
    expect(
      conversation().getByText(
        /This turn failed\. The harness could not run the final check/,
      ),
    ).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "The account's usage limit was reached.",
    );
  },
);

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

const readFile = (id: string): TranscriptItem =>
  inTurn({
    id,
    at,
    kind: "steps",
    steps: [
      {
        kind: "read",
        target: "src/auth/limiter.ts",
        targets: [{ text: "src/auth/limiter.ts" }],
      },
    ],
  });

test("a finished turn with only an answer still shows its time, on a quiet line where a work line would be", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 20, 12));
  await open(
    one({ id: "c-quiet", title: "Limiter" }, [
      youSaid,
      turnTiming("completed", "2026-11-10T10:02:13Z"),
      inTurn(reply("r1", "The limiter is in.")),
    ]),
  );
  // No work line, so no fold button; the time stands on its own line.
  noButton(/Worked/);
  const time = document.querySelector<HTMLElement>(".chat-turn-time")!;
  expect(time.textContent).toMatch(/^Nov\s+10$/);
  expect(time.closest(".chat-foldline")?.querySelector("button")).toBeNull();
  // The line comes before the answer, as a work line does.
  const answer = document.querySelector('[data-anchor="r1"]')!;
  expect(
    time.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  fireEvent.pointerMove(time);
  expect((await screen.findByRole("tooltip")).textContent).toMatch(
    /^Started Nov 10(, 2026)?, .+ · Ended .+$/,
  );
});

test("a finished turn shows its start once, on the work line, with the exact times in its tooltip", async () => {
  // Only the date is fixed, so the day label does not depend on when the suite runs.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 20, 12));
  await open(
    one({ id: "c1", title: "Limiter" }, [
      youSaid,
      turnTiming("completed", "2026-11-10T10:02:13Z"),
      readFile("s1"),
      inTurn(reply("r1", "The limiter is in.")),
    ]),
  );
  const time = document.querySelector<HTMLElement>(".chat-turn-time")!;
  expect(time.textContent).toMatch(/^Nov\s+10$/);
  // The time is not part of the fold button's name: that stays the work line's words.
  expect(button("Worked for 2m 13s").textContent).not.toMatch(/Nov/);
  fireEvent.pointerMove(time);
  expect((await screen.findByRole("tooltip")).textContent).toMatch(
    /^Started Nov 10(, 2026)?, .+ · Ended .+$/,
  );
  // Your message has no time under it; Copy stays.
  expect(document.querySelector(".chat-you-part .chat-fine")).toBeNull();
  expect(
    within(document.querySelector<HTMLElement>(".chat-you-part")!).getByRole(
      "button",
      { name: "Copy message" },
    ),
  ).toBeTruthy();
});

test("Copy and Save as Document belong to a turn's final response, not its progress notes", async () => {
  await open(
    one({ id: "c1", title: "Limiter" }, [
      youSaid,
      turnTiming("completed", "2026-11-10T10:02:13Z"),
      inTurn(reply("r1", "Reading the limiter first.")),
      readFile("s1"),
      inTurn(reply("r2", "The limiter is in.")),
    ]),
  );
  const names = ["Copy response", "Save as Document"];
  const count = () =>
    names.map((name) => screen.queryAllByRole("button", { name }).length);
  expect(count()).toEqual([1, 1]);
  // Opening the work shows the progress note, and it still has no actions.
  fireEvent.click(button("Worked for 2m 13s"));
  expect(conversation().getByText("Reading the limiter first.")).toBeTruthy();
  expect(count()).toEqual([1, 1]);
  // The actions sit at the end of the turn, below everything it shows.
  const unit = button("Copy response").closest(".chat-turn-unit")!;
  expect(unit.lastElementChild?.contains(button("Copy response"))).toBe(true);
});

test("a turn still running offers no reply actions", async () => {
  await open(
    one({ id: "c1", title: "Limiter", activity: "working" }, [
      youSaid,
      turnTiming("active"),
      inTurn(reply("r1", "Reading the limiter first.")),
      readFile("s1"),
    ]),
  );
  // A running turn's text arrives in chunks, so it is read as a whole.
  await waitFor(() =>
    expect(document.querySelector(".chat-col")?.textContent).toContain(
      "Reading the limiter first.",
    ),
  );
  noButton("Copy response");
  noButton("Save as Document");
});

/** Opens the turn's one stretch row, which a turn with no progress notes still has. */
const openStretch = () =>
  fireEvent.click(document.querySelector<HTMLElement>(".chat-stretch-row")!);

test("a finished turn folds under one row, its final response outside, and opens to each step's output", async () => {
  await open(
    one({ id: "finished-fold", title: "Limiter" }, [
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
  openStretch();
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
    one({ id: "stopped-fold", title: "Migrate" }, [
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
  openStretch();
  expect(button("Run npm run test:all, Not finished")).toBeTruthy();
  expect(
    screen.getByText("You stopped this turn. Edits already made are kept."),
  ).toBeTruthy();
});

test("a turn ticketd stopped for a take-over says so, not that ticketd quit", async () => {
  await open(
    one({ id: "c1", title: "Migrate" }, [
      youSaid,
      turnTiming("quit", "2026-11-10T10:00:40Z"),
      { id: "t1", at, kind: "marker", reason: "taken_over", turn_id: "t1" },
    ]),
    "Migrate",
  );
  expect(
    await screen.findByText(
      "You took this run over. Edits already made are kept.",
    ),
  ).toBeTruthy();
  expect(screen.queryByText(/ticketd quit/)).toBeNull();
});

test("a turn ticketd stopped because the Chat was trashed says so in its own words", async () => {
  await open(
    one({ id: "c1", title: "Migrate" }, [
      youSaid,
      turnTiming("quit", "2026-11-10T10:00:40Z"),
      { id: "t1", at, kind: "marker", reason: "trashed", turn_id: "t1" },
    ]),
    "Migrate",
  );
  expect(
    await screen.findByText(
      "Stopped when the Chat was moved to the trash. Edits already made are kept.",
    ),
  ).toBeTruthy();
});

test("a failure message without a full stop still ends its sentence", async () => {
  const client = await open(one({ id: "c1", title: "Migrate" }), "Migrate");
  act(() =>
    client.patch("c1", {
      problem: {
        kind: "failed",
        message: "The Claude bridge did not answer open within 30 seconds",
      },
    }),
  );
  expect(
    (await screen.findByText("Codex stopped with an error")).parentElement
      ?.textContent,
  ).toContain(
    "The Claude bridge did not answer open within 30 seconds. What it finished before that is kept;",
  );
});

test("while a turn runs its steps show as they start, and the working line only between steps", async () => {
  // The elapsed label tests the supplied timestamps, not time spent rendering.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-10T10:00:12Z"));
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
    one({ id: "records-step", title: "Limiter" }, [
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
  openStretch();
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
  // The turn's fold and the stretch holding the change both open: no second click.
  expect(
    screen.getByRole("group", { name: "Worked for 30s" }).textContent,
  ).toContain("Created the Document Reset email copy");
  expect(
    document.querySelector(".chat-stretch-row")?.getAttribute("aria-expanded"),
  ).toBe("true");
  // A reader who then closes the stretch is not overruled.
  openStretch();
  expect(
    document.querySelector(".chat-stretch-row")?.getAttribute("aria-expanded"),
  ).toBe("false");
});

test("more opens the stretch even when the turn's fold is already open", async () => {
  await open(
    one({ id: "receipt-open", title: "Limiter" }, [
      youSaid,
      turnTiming("completed", "2026-11-10T10:00:30Z"),
      inTurn({
        id: "rec1",
        at,
        kind: "records",
        changes: [
          { kind: "update", reference: "T-12", excerpt: "Limiter is in" },
          { kind: "update", reference: "T-13", excerpt: "Tests pass" },
          { kind: "document", document_id: "d9", title: "Reset email copy" },
        ],
      }),
    ]),
  );
  fireEvent.click(button("Worked for 30s"));
  expect(
    document.querySelector(".chat-stretch-row")?.getAttribute("aria-expanded"),
  ).toBe("false");
  fireEvent.click(button("1 more"));
  expect(
    document.querySelector(".chat-stretch-row")?.getAttribute("aria-expanded"),
  ).toBe("true");
  expect(
    screen.getByRole("group", { name: "Worked for 30s" }).textContent,
  ).toContain("Created the Document Reset email copy");
});

test("a ticket moved twice in a turn reads as the host's net move in the receipt row", async () => {
  const status = (from: string, to: string) => ({
    kind: "status" as const,
    reference: "T-12",
    title: "Improve the export dialog",
    from,
    to,
  });
  const update = {
    kind: "update" as const,
    reference: "T-12",
    excerpt: "Started",
  };
  await open(
    one({ id: "netted", title: "Limiter" }, [
      youSaid,
      turnTiming("completed", "2026-11-10T10:00:30Z"),
      inTurn({
        id: "rec1",
        at,
        kind: "records",
        changes: [status("Todo", "In progress"), update],
        net: [status("Todo", "In progress"), update],
      }),
      inTurn({
        id: "rec2",
        at,
        kind: "records",
        changes: [status("In progress", "In review")],
        // The host nets the whole turn on its last call.
        net: [status("Todo", "In review"), update],
      }),
    ]),
  );
  expect(document.querySelector(".chat-records-items")?.textContent).toBe(
    "Moved T-12 to In review · Posted an update on T-12",
  );
  // Two sentences: nothing more to open.
  expect(screen.queryByRole("button", { name: /more/ })).toBeNull();
  // The fold still lists each change as its own step row.
  fireEvent.click(button(/^Worked for 30s/));
  openStretch();
  const fold = screen.getByRole("group", { name: "Worked for 30s" });
  expect(fold.textContent).toContain("Moved T-12 to In progress");
  expect(fold.textContent).toContain("Moved T-12 to In review");
});

test("a receipt from an older host, with no net list, says each change", async () => {
  const status = (from: string, to: string) => ({
    kind: "status" as const,
    reference: "T-12",
    title: "Improve the export dialog",
    from,
    to,
  });
  await open(
    one({ id: "older-host", title: "Limiter" }, [
      youSaid,
      turnTiming("completed", "2026-11-10T10:00:30Z"),
      inTurn({
        id: "rec1",
        at,
        kind: "records",
        changes: [status("Todo", "In progress"), status("In progress", "Done")],
      }),
    ]),
  );
  expect(document.querySelector(".chat-records-items")?.textContent).toBe(
    "Moved T-12 to In progress · Moved T-12 to Done",
  );
});

/** The queue's head line; its count is an element of its own. */
const queueHead = (text: string | RegExp) =>
  screen.getByText((_, element) => {
    const said = element?.textContent ?? "";
    return (
      element?.tagName === "SPAN" &&
      (typeof text === "string" ? said === text : text.test(said))
    );
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
    const sent = client.readThroughs.length;
    fireEvent.scroll(document.querySelector<HTMLElement>(".chat-scroll")!);
    // Kept once scrolling pauses, not on every scroll event.
    expect(client.readThroughs).toHaveLength(sent);
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
  // CH-33: said once in the pane's status line, never left above the composer.
  expect(
    await screen.findByText("Saved “Login rate limiter” to Documents"),
  ).toBeTruthy();
  expect(client.savedDocuments).toEqual(["Login rate limiter"]);
  expect(document.querySelector(".chat-dock .chat-fine")).toBeNull();
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

test("the context button carries no native title; its path is the shared tooltip", async () => {
  await open(one({ id: "c1", title: "Limiter" }));
  expect(button(/^Folder web-app/).hasAttribute("title")).toBe(false);
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

test("a signed-out Antigravity Chat shows one sign-in instruction and holds its input", async () => {
  const user = userEvent.setup();
  const client = await open(
    one({
      id: "c1",
      title: "Antigravity Chat",
      harness: { id: "antigravity", name: "Antigravity" },
      problem: {
        kind: "not_signed_in",
        command: "agy",
        message: "The credentials for this profile expired",
      },
      queue_paused: true,
      queue: [{ id: "q1", text: "Write the changelog" }],
    }),
  );
  const notice = screen.getByRole("alert");
  expect(
    notice.textContent?.match(/Antigravity isn't signed in/g),
  ).toHaveLength(1);
  expect(
    notice.textContent?.match(/Run agy in a terminal and sign in/g),
  ).toHaveLength(1);
  expect(notice.textContent).toContain(
    "The credentials for this profile expired.",
  );
  await user.click(
    within(notice).getByRole("button", { name: "Copy command" }),
  );
  expect(await navigator.clipboard.readText()).toBe("agy");
  await user.click(within(notice).getByRole("button", { name: "Check again" }));
  expect(
    within(screen.getByRole("list", { name: "Queued messages" })).getByText(
      "Write the changelog",
    ),
  ).toBeTruthy();
  expect(queueHead("Queued 1 · Paused")).toBeTruthy();
  expect((await client.openChat("c1")).chat.problem?.kind).toBe(
    "not_signed_in",
  );
});

test("a linked Project opens its ticket scope and can still be unlinked", async () => {
  const openProject = vi.fn();
  await open(one({ id: "c1", title: "Limiter" }), undefined, openProject);
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
  fireEvent.click(
    links.getByRole("button", { name: "Open the Project Storefront" }),
  );
  expect(openProject).toHaveBeenCalledWith("p1");
  fireEvent.click(
    links.getByRole("button", {
      name: "Remove the link to the Project Storefront",
    }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("group", { name: "Linked records" })).toBeNull(),
  );
});

test("a late Chat link search cannot replace the current archived-only explanation", async () => {
  const client = await open(
    one({
      id: "c1",
      title: "Limiter",
      links: [{ kind: "project", id: "p1", title: "Storefront" }],
    }),
  );
  let resolveOlder!: (value: LinkedRecord[]) => void;
  const search = vi
    .spyOn(client, "searchRecords")
    .mockImplementation((query) => {
      if (query === "store")
        return new Promise((resolve) => {
          resolveOlder = resolve;
        });
      if (query === "archive")
        return Promise.resolve([
          { kind: "project", id: "old", title: "Old archive", archived: true },
        ]);
      return Promise.resolve([]);
    });
  await linkFromMenu();
  const field = screen.getByLabelText(
    "Search tickets, Documents and Projects by title or reference",
  );
  fireEvent.change(field, { target: { value: "store" } });
  await waitFor(() => expect(search).toHaveBeenCalledWith("store"));
  fireEvent.change(field, { target: { value: "archive" } });
  const hint =
    "Old archive is archived. Reactivate it on the Projects page to link it.";
  await screen.findByText(hint);
  expect(
    screen.queryByText("No ticket, Document or Project has that in its name."),
  ).toBeNull();
  await act(async () => {
    resolveOlder([{ kind: "project", id: "p1", title: "Storefront" }]);
  });
  expect(screen.getByText(hint)).toBeTruthy();
  expect(
    screen.queryByText("Everything with that name is already linked."),
  ).toBeNull();
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
      message: `Found Codex 0.1.0 at \`${path}\`. ticketd needs Codex 0.163.0 or newer.`,
    },
  ]);
  fireEvent.click(await screen.findByRole("button", { name: "New Chat" }));
  const sentence = await screen.findByText(/ticketd needs Codex 0\.163\.0/);
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
    { id: "fixture-harness", name: "Fixture Harness", status: "ready" },
  ]);
  fireEvent.click(await screen.findByRole("button", { name: "New Chat" }));
  // No radios: the harness is the picker's, beside Send.
  const trigger = await screen.findByRole("button", {
    name: "Claude Code, model Opus 5.5",
  });
  expect(screen.queryByRole("radiogroup", { name: "Harness" })).toBeNull();
  fireEvent.click(trigger);
  const tabs = await screen.findByRole("tablist", { name: "Harness" });
  // A harness that isn't ready is dimmed with its word.
  expect(
    within(tabs).getByRole("tab", { name: /Codex.*Not signed in/ }),
  ).toBeTruthy();
  expect(
    within(tabs).getByRole("tab", { name: "Fixture Harness" }),
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

test("New Chat shows why the Antigravity model check failed beside Default", async () => {
  localStorage.clear();
  const client = await open([]);
  const reason =
    "Antigravity's model check failed (exit status: 23). Run agy models in a terminal for details.";
  client.options.set("antigravity", {
    harness_id: "antigravity",
    models: [],
    unavailable: reason,
  });
  client.setHarnesses([
    { id: "antigravity", name: "Antigravity", status: "ready" },
  ]);
  fireEvent.click(await screen.findByRole("button", { name: "New Chat" }));
  fireEvent.click(await screen.findByRole("button", { name: "Antigravity" }));

  const picker = await screen.findByRole("dialog", {
    name: "Harness and model",
  });
  expect(within(picker).getByText("Default")).toBeTruthy();
  expect(
    within(picker).getByText(`${reason} It will use its default model.`),
  ).toBeTruthy();
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
      name: "Claude Code, model Opus 5.5",
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
  fireEvent.click(await screen.findByRole("button", { name: "Claude Code" }));
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

test("New Chat starts in the Project checkout chosen from the folder menu", async () => {
  const client = await open([]);
  const project = { id: "p1", title: "Storefront" };
  const checkout = String.raw`\\?\C:\Worktrees\storefront`;
  client.projectCheckouts = [
    { project, path: String.raw`\\?\C:\Projects\storefront` },
    { project, path: checkout },
  ];
  const browse = vi.spyOn(client, "pickFolder");
  fireEvent.click(await screen.findByRole("button", { name: "New Chat" }));
  fireEvent.keyDown(button("Scratch folder"), { key: "Enter" });
  expect(
    await screen.findByRole("menuitem", {
      name: String.raw`Storefront C:\Projects\storefront`,
    }),
  ).toBeTruthy();
  fireEvent.click(
    screen.getByRole("menuitem", {
      name: String.raw`Storefront C:\Worktrees\storefront`,
    }),
  );
  expect(browse).not.toHaveBeenCalled();
  expect(button(String.raw`Folder: C:\Worktrees\storefront`)).toBeTruthy();

  type("Review the checkout", "Describe a task or ask a question");
  await waitFor(() => expect(button("Send")).toHaveProperty("disabled", false));
  fireEvent.click(button("Send"));
  await screen.findByRole("heading", { name: "Review the checkout" });
  const { chat } = await client.openChat("chat-1");
  expect(chat.folder.path).toBe(checkout);
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

test("New Chat keeps its Project link and removes it from mentions when the Project is archived", async () => {
  const project = { id: "p1", name: "Storefront", path: "", paths: [] };
  const client = createMockChatClient({
    enabled: true,
    records: [
      { kind: "project", id: project.id, title: project.name },
      { kind: "document", id: "d1", title: "Deployment notes" },
    ],
  });
  function Draft({ archived }: { archived: boolean }) {
    return (
      <ChatClientContext value={client}>
        <ChatProvider>
          <StatusLineRegion>
            <ChatsView projects={[{ ...project, archived }]} />
          </StatusLineRegion>
        </ChatProvider>
      </ChatClientContext>
    );
  }
  const { rerender } = render(<Draft archived={false} />);
  fireEvent.click(await screen.findByRole("button", { name: "New Chat" }));
  fireEvent.click(button("Link a ticket, Document or Project"));
  fireEvent.click(await screen.findByRole("option", { name: /Storefront/ }));
  type("", "Describe a task or ask a question");
  fireEvent.change(composer("Describe a task or ask a question"), {
    target: { value: "#", selectionStart: 1 },
  });
  expect(
    await screen.findByRole("option", { name: /Storefront/ }),
  ).toBeTruthy();

  rerender(<Draft archived />);
  await waitFor(() =>
    expect(screen.queryByRole("option", { name: /Storefront/ })).toBeNull(),
  );
  expect(button("Remove the link to the Project Storefront")).toBeTruthy();
  type("", "Describe a task or ask a question");
});

test("New Chat on Claude Code sends the shown default model and permission mode, untouched", async () => {
  localStorage.clear();
  const client = await open([]);
  client.setHarnesses([
    { id: "claude-code", name: "Claude Code", status: "ready" },
  ]);
  fireEvent.click(await screen.findByRole("button", { name: "New Chat" }));
  await screen.findByRole("button", {
    name: "Claude Code, model Opus 5.5",
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
  fireEvent.click(
    await screen.findByRole("menuitemradio", { name: /^Ask before edits/ }),
  );
  await waitFor(() =>
    expect(asked).toEqual(["model=sonnet", "permission=ask"]),
  );
});

test("Full access is one pick away in a Chat and shows on the trigger once in effect", async () => {
  const permission = (current: string): HarnessSetting => ({
    current,
    options: [
      { ...option("default", "Ask before edits", true), permission: "ask" },
      {
        ...option("bypassPermissions", "Full access"),
        description: "Runs tools and commands without asking",
        permission: "full_access",
      },
    ],
    changeable: true,
    applies_from: "next_request",
  });
  const client = await open(
    one({
      id: "c1",
      title: "Limiter",
      harness: { id: "claude-code", name: "Claude Code" },
      settings: { permission: permission("default") },
    }),
  );
  const asked: string[] = [];
  client.changeSetting = async (_id, setting, value) => {
    asked.push(`${setting}=${value}`);
    return { value, state: "applied" };
  };

  openMenu("Permissions: Ask before edits");
  const full = await screen.findByRole("menuitemradio", {
    name: /^Full access/,
  });
  // What it means is said where it is chosen.
  expect(full.textContent).toContain("Runs tools and commands without asking");
  fireEvent.click(full);
  await waitFor(() => expect(asked).toEqual(["permission=bypassPermissions"]));

  act(() =>
    client.patch("c1", {
      settings: { permission: permission("bypassPermissions") },
    }),
  );
  expect(
    await screen.findByRole("button", { name: "Permissions: Full access" }),
  ).toBeTruthy();
});

test("a refused change names its choice after the options go, and Stop clears it (#387 M16)", async () => {
  const client = await open(
    one({
      id: "c1",
      title: "Limiter",
      activity: "working",
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
      },
    }),
  );
  client.changeSetting = async (_id, _setting, value) => ({
    value,
    state: "refused",
    reason: "An Automation is running this Chat.",
  });
  fireEvent.click(button("Claude Code, model Opus 5.5"));
  fireEvent.click(await screen.findByRole("radio", { name: /^Sonnet 5/ }));
  fireEvent.keyDown(document.activeElement ?? document.body, {
    key: "Escape",
  });
  const line =
    "Claude Code didn't switch to Sonnet 5: An Automation is running this Chat.";
  expect(await screen.findByText(line)).toBeTruthy();
  // The session that listed the options closes: the line keeps the choice's name.
  act(() => client.patch("c1", { settings: null }));
  expect(await screen.findByText(line)).toBeTruthy();

  fireEvent.click(button("Stop"));
  await waitFor(() => expect(screen.queryByText(line)).toBeNull());
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
  fireEvent.click(button("Codex"));
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

/** A turn's step, as the host sends it; `state` makes it the one running. */
const stepItem = (
  id: string,
  step: Step,
  state: Step["state"] = "done",
): TranscriptItem =>
  inTurn({ id, at, kind: "steps", steps: [{ ...step, state }] });
const readLimiter: Step = {
  kind: "read",
  target: "src/auth/limiter.ts",
  targets: [{ text: "src/auth/limiter.ts" }],
};
const npmTest: Step = { kind: "run", target: "npm test", command: "npm test" };
const stretchRows = () =>
  Array.from(document.querySelectorAll<HTMLElement>(".chat-stretch-row")).map(
    (row) => row.textContent,
  );

test("a working Chat opens with its done stretches folded and the one in progress open", async () => {
  await open(
    one({ id: "stretch-open", title: "Limiter", activity: "working" }, [
      youSaid,
      turnTiming("active"),
      stepItem("s1", readLimiter),
      inTurn(reply("n1", "Reading the limiter first.")),
      stepItem("s2", npmTest),
      inTurn(reply("n2", "The tests ran.")),
      stepItem("s3", { ...npmTest, target: "npm run lint" }, "running"),
    ]),
  );
  // The notes stay as lines of the story; each finished stretch is one row.
  expect(stretchRows()).toEqual(["Read 1 file", "Ran 1 command"]);
  expect(button("Read 1 file").getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByText("src/auth/limiter.ts")).toBeNull();
  // The stretch in progress shows its steps as they come, with no row of its own.
  expect(button("Running npm run lint")).toBeTruthy();
  // Only the turn is still going: no work line yet.
  noButton(/Worked/);
});

/** What the transcript's reader sees: the scroller is 600px tall, `place` is where a stretch sits. */
function watching() {
  const place = { top: 100, bottom: 200 };
  const rect = vi
    .spyOn(Element.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: Element) {
      const box = this.classList.contains("chat-scroll")
        ? { top: 0, bottom: 600 }
        : place;
      return {
        ...box,
        left: 0,
        right: 0,
        width: 0,
        height: 0,
        x: 0,
        y: 0,
      } as DOMRect;
    });
  const observers: { node: Element; run: (seen: boolean) => void }[] = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      callback: IntersectionObserverCallback;
      constructor(callback: IntersectionObserverCallback) {
        this.callback = callback;
      }
      observe(node: Element) {
        observers.push({
          node,
          run: (seen) =>
            this.callback(
              [{ isIntersecting: seen } as IntersectionObserverEntry],
              this as unknown as IntersectionObserver,
            ),
        });
      }
      unobserve() {}
      disconnect() {}
    },
  );
  return {
    place,
    /** The view moves: what is watched is now out of it, or in it. */
    sees: (seen: boolean) =>
      act(() =>
        observers
          .filter((each) => each.node.classList.contains("chat-stretch"))
          .forEach((each) => each.run(seen)),
      ),
    done: () => {
      rect.mockRestore();
      vi.unstubAllGlobals();
    },
  };
}

test("a stretch that finishes in view stays open until it has left the view, then folds", async () => {
  const view = watching();
  try {
    const client = await open(
      one({ id: "stretch-held", title: "Limiter", activity: "working" }, [
        youSaid,
        turnTiming("active"),
        stepItem("s1", npmTest, "running"),
      ]),
    );
    act(() => {
      client.push("stretch-held", stepItem("s1", npmTest));
      client.push("stretch-held", inTurn(reply("n1", "The tests ran.")));
    });
    // A note follows it, so it is done; but someone is looking at it.
    expect(button("Ran npm test")).toBeTruthy();
    expect(stretchRows()).toEqual([]);
    // It leaves the view: only now does it fold to its row.
    view.sees(false);
    expect(stretchRows()).toEqual(["Ran 1 command"]);
    expect(screen.queryByRole("button", { name: "Ran npm test" })).toBeNull();
  } finally {
    view.done();
  }
});

test("a stretch that left the view keeps a focused step until focus moves on", async () => {
  const view = watching();
  try {
    const client = await open(
      one({ id: "stretch-focused", title: "Limiter", activity: "working" }, [
        youSaid,
        turnTiming("active"),
        stepItem("s1", npmTest, "running"),
      ]),
    );
    act(() => {
      client.push("stretch-focused", stepItem("s1", npmTest));
      client.push("stretch-focused", inTurn(reply("n1", "The tests ran.")));
    });
    const step = button("Ran npm test");
    step.focus();
    expect(document.activeElement).toBe(step);
    // It leaves the view, but the keyboard is inside it: nothing is removed.
    view.sees(false);
    expect(document.activeElement).toBe(step);
    expect(stretchRows()).toEqual([]);
    // Focus moves on: now it folds.
    act(() => step.blur());
    await waitFor(() => expect(stretchRows()).toEqual(["Ran 1 command"]));
  } finally {
    view.done();
  }
});

test("a stretch that finishes out of view folds at once", async () => {
  const view = watching();
  // Below the scroller's 600px: nobody is looking.
  view.place.top = 900;
  view.place.bottom = 1000;
  try {
    const client = await open(
      one({ id: "stretch-away", title: "Limiter", activity: "working" }, [
        youSaid,
        turnTiming("active"),
        stepItem("s1", npmTest, "running"),
      ]),
    );
    act(() => {
      client.push("stretch-away", stepItem("s1", npmTest));
      client.push("stretch-away", inTurn(reply("n1", "The tests ran.")));
    });
    expect(stretchRows()).toEqual(["Ran 1 command"]);
  } finally {
    view.done();
  }
});

test("a finished turn opens to its notes and stretch rows, and a stretch opens to its steps", async () => {
  await open(
    one({ id: "stretch-finished", title: "Limiter" }, [
      youSaid,
      turnTiming("completed", "2026-11-10T10:02:13Z"),
      inTurn(reply("n1", "Reading the limiter first.")),
      stepItem("s1", readLimiter),
      stepItem("s2", npmTest),
      inTurn(reply("n2", "Checking the tests.")),
      stepItem("s3", { ...npmTest, target: "npm run lint" }, "failed"),
      inTurn(reply("r1", "The limiter is in.")),
    ]),
  );
  expect(screen.queryByText("Reading the limiter first.")).toBeNull();
  fireEvent.click(button("Worked for 2m 13s · 1 failed"));
  expect(conversation().getByText("Reading the limiter first.")).toBeTruthy();
  expect(conversation().getByText("Checking the tests.")).toBeTruthy();
  // Not every step: one row for each stretch, the failure on the row that holds it.
  expect(stretchRows()).toEqual([
    "Read 1 file and ran 1 command",
    "Ran 1 command · 1 failed",
  ]);
  expect(screen.queryByText("src/auth/limiter.ts")).toBeNull();
  fireEvent.click(button("Read 1 file and ran 1 command"));
  expect(button("Ran npm test")).toBeTruthy();
  expect(
    within(
      screen.getByRole("group", { name: "Read 1 file and ran 1 command" }),
    ).getByRole("button", { name: "Open src/auth/limiter.ts" }),
  ).toBeTruthy();
});

test("a turn with no progress notes shows its one stretch as a row when opened", async () => {
  await open(
    one({ id: "stretch-single", title: "Limiter" }, [
      youSaid,
      turnTiming("completed", "2026-11-10T10:00:30Z"),
      stepItem("s1", readLimiter),
      stepItem("s2", npmTest),
      inTurn(reply("r1", "The limiter is in.")),
    ]),
  );
  fireEvent.click(button("Worked for 30s"));
  expect(stretchRows()).toEqual(["Read 1 file and ran 1 command"]);
  expect(screen.queryByRole("button", { name: "Ran npm test" })).toBeNull();
  fireEvent.click(button("Read 1 file and ran 1 command"));
  expect(button("Ran npm test")).toBeTruthy();
});

test("a stretch of one Explored row opens straight to its files, with no row repeating its words", async () => {
  await open(
    one({ id: "stretch-explored", title: "Limiter" }, [
      youSaid,
      turnTiming("completed", "2026-11-10T10:00:30Z"),
      inTurn(reply("n1", "Looking around first.")),
      inTurn({
        id: "s1",
        at,
        kind: "steps",
        steps: [
          { ...readLimiter, state: "done" },
          {
            kind: "search",
            target: "limit",
            targets: [{ text: "limit", scope: "src" }],
            state: "done",
          },
        ],
      }),
      inTurn(reply("r1", "The limiter is in.")),
    ]),
  );
  fireEvent.click(button("Worked for 30s"));
  fireEvent.click(button("Explored 1 file · 1 search"));
  // The files are right there; the same words are not said a second time.
  expect(button("Open src/auth/limiter.ts")).toBeTruthy();
  expect(screen.getAllByText("Explored 1 file · 1 search")).toHaveLength(1);
});

test("the stretches you open stay as you left them for the session", async () => {
  await open(
    one({ id: "stretch-toggled", title: "Limiter" }, [
      youSaid,
      turnTiming("completed", "2026-11-10T10:02:13Z"),
      inTurn(reply("n1", "Reading the limiter first.")),
      stepItem("s1", readLimiter),
      inTurn(reply("r1", "The limiter is in.")),
    ]),
  );
  fireEvent.click(button("Worked for 2m 13s"));
  fireEvent.click(button("Read 1 file"));
  expect(button("Read 1 file").getAttribute("aria-expanded")).toBe("true");
  // Away and back: the Chat's rows are drawn again, the toggles are kept.
  fireEvent.click(button("Close Chat"));
  fireEvent.click(await screen.findByRole("button", { name: /^Limiter/ }));
  await screen.findByRole("heading", { name: "Limiter" });
  expect(button("Read 1 file").getAttribute("aria-expanded")).toBe("true");
  expect(
    screen.getByRole("button", { name: "Open src/auth/limiter.ts" }),
  ).toBeTruthy();
  // And closing one stays closed.
  fireEvent.click(button("Read 1 file"));
  expect(button("Read 1 file").getAttribute("aria-expanded")).toBe("false");
});

test("between steps, while words stream, the one live line says Writing", async () => {
  await open(
    one({ id: "writing", title: "Limiter", activity: "working" }, [
      youSaid,
      turnTiming("active"),
      stepItem("s1", npmTest),
      inTurn({
        id: "n1",
        at,
        kind: "response",
        text: "The tests ran, now",
        state: "streaming",
      }),
    ]),
  );
  expect(working()).toMatch(/^Writing/);
  // Its clock counts from when it appeared, not from the turn's start.
  expect(working()).not.toMatch(/for/);
  expect(document.querySelectorAll(".chat-spin")).toHaveLength(1);
});
