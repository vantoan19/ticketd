// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { ChatClientContext } from "@/features/chats/client";
import { ChatProvider } from "@/features/chats/ChatProvider";
import { ChatsView } from "@/features/chats/ChatsView";
import {
  createMockChatClient,
  type MockChat,
} from "@/features/chats/mock-client";
import { cutTitle } from "@/features/chats/model";
import { subAgentPartFixtures } from "@/features/chats/sub-agent-part-fixtures";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

afterEach(cleanup);

async function open(chat: MockChat) {
  const client = createMockChatClient({ enabled: true, chats: [chat] });
  render(
    <ChatClientContext value={client}>
      <ChatProvider>
        <ChatsView />
      </ChatProvider>
    </ChatClientContext>,
  );
  fireEvent.click(
    await screen.findByRole("button", {
      name: new RegExp(`^${chat.chat.title}`),
    }),
  );
  await screen.findByRole("heading", { name: chat.chat.title });
  return client;
}

const chatsCss = readFileSync(join(__dirname, "chats.css"), "utf8");
const fixtures = () => subAgentPartFixtures();

test("while sub-agents run after the reply, one pill counts them in the tray", async () => {
  await open(fixtures().reply);
  const pill = screen.getByRole("button", { name: "2 sub-agents running" });
  expect(pill.getAttribute("aria-haspopup")).toBe("dialog");
  expect(pill.getAttribute("aria-expanded")).toBe("false");
  // The strip is the only live signal: no working line, and the box offers a plain message.
  expect(screen.queryByText("Working…")).toBeNull();
  expect(screen.getByPlaceholderText("Message Claude Code")).toBeTruthy();
});

test("the pill opens a list of what runs, and Esc closes it", async () => {
  await open(fixtures().reply);
  const pill = screen.getByRole("button", { name: "2 sub-agents running" });
  fireEvent.click(pill);
  const list = await screen.findByRole("dialog", {
    name: "Running sub-agents",
  });
  expect(pill.getAttribute("aria-expanded")).toBe("true");
  expect(
    within(list)
      .getAllByRole("button", { name: /^(?!Stop)/ })
      .map((one) => one.textContent),
  ).toEqual([
    expect.stringMatching(/^Find limiter bypasses2m \d+s$/),
    expect.stringMatching(/^Check limiter test coverage2m \d+s$/),
  ]);
  fireEvent.keyDown(list, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("one running sub-agent: the pill names it and opens its view", async () => {
  await open(fixtures().one);
  const pill = screen.getByRole("button", {
    name: /^Find limiter bypasses, working, 2m \d+s$/,
  });
  expect(pill.getAttribute("aria-haspopup")).toBeNull();
  fireEvent.click(pill);
  expect(
    await screen.findByRole("heading", { name: "Find limiter bypasses" }),
  ).toBeTruthy();
});

test("in the list, arrows move between rows, Enter opens one, Tab reaches Stop", async () => {
  await open(fixtures().reply);
  fireEvent.click(screen.getByRole("button", { name: "2 sub-agents running" }));
  const list = await screen.findByRole("dialog", {
    name: "Running sub-agents",
  });
  const items = within(list).getAllByRole("button", { name: /^(?!Stop)/ });
  items[0]?.focus();
  fireEvent.keyDown(items[0] as HTMLElement, { key: "ArrowDown" });
  expect(document.activeElement).toBe(items[1]);
  fireEvent.keyDown(items[1] as HTMLElement, { key: "ArrowUp" });
  expect(document.activeElement).toBe(items[0]);
  expect(
    within(list).getByRole("button", { name: "Stop Find limiter bypasses" }),
  ).toBeTruthy();
  fireEvent.click(items[1] as HTMLElement);
  expect(
    await screen.findByRole("heading", { name: "Check limiter test coverage" }),
  ).toBeTruthy();
});

test("nested sub-agents sit one level in under their parent", async () => {
  await open(fixtures().codexNested);
  fireEvent.click(screen.getByRole("button", { name: "3 sub-agents running" }));
  const list = await screen.findByRole("dialog", {
    name: "Running sub-agents",
  });
  const nested = within(list)
    .getByRole("button", { name: /^Run the payment tests/ })
    .closest("li");
  expect(nested?.getAttribute("data-depth")).toBe("1");
  expect(
    within(list)
      .getAllByRole("listitem")
      .map((li) => li.getAttribute("data-depth")),
  ).toEqual([null, "1", null]);
});

test("the plan pill and the strip share one line", async () => {
  await open(fixtures().plan);
  const plan = screen.getByRole("button", { name: /2 of 4 done/ });
  const strip = screen.getByRole("button", { name: "2 sub-agents running" });
  expect(plan.parentElement).toBe(strip.parentElement);
});

test("Stop in a list row stops that sub-agent alone, with no confirmation", async () => {
  const client = await open(fixtures().reply);
  const stop = vi.spyOn(client, "stopSubAgent");
  fireEvent.click(screen.getByRole("button", { name: "2 sub-agents running" }));
  const list = await screen.findByRole("dialog", {
    name: "Running sub-agents",
  });
  fireEvent.click(
    within(list).getByRole("button", { name: "Stop Find limiter bypasses" }),
  );
  expect(stop).toHaveBeenCalledWith("c-limiter", "sa-bypass");
  // Its row says so, and the strip now names the one that is left.
  expect(
    (
      await screen.findByRole("button", {
        name: /^Sub-agent Find limiter bypasses, stopped/,
      })
    ).textContent,
  ).toBe("Find limiter bypasses · Stopped");
  expect(
    screen.getByRole("button", {
      name: /^Check limiter test coverage, working, 2m/,
    }),
  ).toBeTruthy();
});

test("no strip without a running sub-agent, and none in a Chat without any", async () => {
  await open(fixtures().stoppedAll);
  expect(screen.queryByText(/sub-agents? running/)).toBeNull();
});

test("Stop all says what it stops: the sub-agents alone, or the turn and the sub-agents", async () => {
  await open(fixtures().reply);
  expect(
    screen.getByRole("button", { name: "Stop 2 sub-agents" }),
  ).toBeTruthy();
  cleanup();
  await open(fixtures().inTurn);
  expect(
    screen.getByRole("button", { name: "Stop the turn and 2 sub-agents" }),
  ).toBeTruthy();
});

test("Stop all with no turn stops every sub-agent and leaves a row below the reply", async () => {
  await open(fixtures().reply);
  fireEvent.click(screen.getByRole("button", { name: "Stop 2 sub-agents" }));
  expect(await screen.findByText("You stopped 2 sub-agents.")).toBeTruthy();
  expect(
    screen
      .getAllByRole("button", { name: /^Sub-agent .*, stopped/ })
      .map((one) => one.textContent),
  ).toEqual([
    "Find limiter bypasses · Stopped",
    "Check limiter test coverage · Stopped",
  ]);
  // Nothing runs: no strip, no Stop, and the box offers a plain message.
  expect(screen.queryByText(/sub-agents? running/)).toBeNull();
  expect(screen.queryByRole("button", { name: /^Stop/ })).toBeNull();
});

test("an approval from a sub-agent names it, and the name opens its view", async () => {
  await open(fixtures().approval);
  const card = await screen.findByRole("group", {
    name: /^Check limiter test coverage wants to run npm test -- rate-limit/,
  });
  const name = within(card).getByRole("button", {
    name: "Check limiter test coverage",
  });
  expect(card.textContent).toContain("wants to run");
  // The sub-agent asks, so the harness is not named in its place.
  expect(card.textContent).not.toContain("Claude Code wants");
  fireEvent.click(name);
  expect(
    await screen.findByRole("heading", { name: "Check limiter test coverage" }),
  ).toBeTruthy();
});

test("in its own view the request sits in the tray with the name as plain text", async () => {
  const client = await open(fixtures().approval);
  fireEvent.click(
    screen.getByRole("button", { name: /^Sub-agent Check limiter test/ }),
  );
  const card = await screen.findByRole("group", {
    name: /^Check limiter test coverage wants to run/,
  });
  expect(
    within(card).queryByRole("button", { name: /^Check limiter/ }),
  ).toBeNull();
  const answer = vi.spyOn(client, "answer");
  fireEvent.click(within(card).getByRole("button", { name: /Allow once/ }));
  await waitFor(() =>
    expect(answer).toHaveBeenCalledWith("c-limiter", "req-tests", {
      option_id: "allow",
    }),
  );
});

test("in another sub-agent's view a line says who needs you, and Review goes there", async () => {
  await open(fixtures().approval);
  fireEvent.click(
    screen.getByRole("button", { name: /^Sub-agent Find limiter bypasses/ }),
  );
  await screen.findByRole("heading", { name: "Find limiter bypasses" });
  const line = screen
    .getByRole("button", { name: "Review" })
    .closest("section") as HTMLElement;
  expect(line.textContent).toContain("Check limiter test coverage needs you");
  expect(screen.queryByRole("group", { name: /wants to run/ })).toBeNull();
  fireEvent.click(within(line).getByRole("button", { name: "Review" }));
  expect(
    await screen.findByRole("heading", { name: "Check limiter test coverage" }),
  ).toBeTruthy();
  expect(
    await screen.findByRole("group", { name: /wants to run/ }),
  ).toBeTruthy();
});

test("a long sub-agent title is cut at about 40 characters in a request", () => {
  expect(
    cutTitle("Review the retry backoff in the webhook sender and queue"),
  ).toBe("Review the retry backoff in the webhook…");
  expect(cutTitle("Find limiter bypasses")).toBe("Find limiter bypasses");
});

test("Stop in a sub-agent's own view stops it alone and leaves how it ended", async () => {
  const client = await open(fixtures().reply);
  const stop = vi.spyOn(client, "stopSubAgent");
  fireEvent.click(
    screen.getByRole("button", { name: /^Sub-agent Find limiter bypasses/ }),
  );
  await screen.findByRole("heading", { name: "Find limiter bypasses" });
  const status = screen.getByText(/^Working · 2m/).closest("[role=status]");
  expect(status?.getAttribute("aria-live")).toBe("polite");
  fireEvent.click(
    screen.getByRole("button", { name: "Stop Find limiter bypasses" }),
  );
  expect(stop).toHaveBeenCalledWith("c-limiter", "sa-bypass");
  expect(await screen.findByText("You stopped it.")).toBeTruthy();
  // It ended, so the view has no tray; the other sub-agent still runs in the Chat.
  expect(document.querySelector(".chat-tray")).toBeNull();
});

test("a turn the harness started says so in place of a message, and the title opens the sub-agent", async () => {
  await open(fixtures().done);
  const line = screen
    .getByText("Started by Claude Code: sub-agent finished")
    .closest("p") as HTMLElement;
  expect(line.textContent).toMatch(
    /Started by Claude Code: sub-agent finished\s*·\s*Check limiter test coverage$/,
  );
  // It stands where the person's message would: before the turn it started.
  expect(screen.queryByText(/^You:/)).toBeTruthy(); // the first turn's own message
  fireEvent.click(
    within(line).getByRole("button", { name: "Check limiter test coverage" }),
  );
  expect(
    await screen.findByRole("heading", { name: "Check limiter test coverage" }),
  ).toBeTruthy();
});

test("a turn the harness started with no sub-agent finished only says who started it", async () => {
  await open(fixtures().startedAlone);
  const line = screen.getByText("Started by Claude Code").closest("p");
  expect(line?.textContent).toBe("Started by Claude Code");
  expect(screen.queryByText(/sub-agent finished/)).toBeNull();
});

test("a turn ticketd started names ticketd, not the harness", async () => {
  await open(fixtures().wake);
  expect(
    screen.getByText("Started by ticketd: sub-agent finished"),
  ).toBeTruthy();
  expect(screen.queryByText(/Started by Codex/)).toBeNull();
});

test("a turn ticketd just started shows why before any of its work", async () => {
  await open(fixtures().wakeStarting);
  expect(
    screen.getByText("Started by ticketd: sub-agent finished"),
  ).toBeTruthy();
});

test("a turn the person started has no such line", async () => {
  await open(subAgentPartFixtures().reply);
  expect(screen.queryByText(/^Started by/)).toBeNull();
});

test("after a restart the tray says what happens next, neutrally", async () => {
  await open(fixtures().restart);
  const notice = screen
    .getByText("2 sub-agents lost contact when ticketd quit")
    .closest("section") as HTMLElement;
  expect(notice.textContent).toContain(
    "Your next message tells Claude Code, which can resume them.",
  );
  // Nothing waits for the person: no attention dot, no buttons.
  expect(notice.querySelector('[data-slot="status-dot"]')).toBeNull();
  expect(within(notice).queryByRole("button")).toBeNull();
  expect(
    screen.getAllByRole("button", { name: /^Sub-agent .*contact lost/ }),
  ).toHaveLength(2);
});

test("the restart notice says Codex without resuming, and one sub-agent in the singular", async () => {
  const base = fixtures().restart;
  await open({
    ...base,
    chat: {
      ...base.chat,
      harness: { id: "codex", name: "Codex" },
      restart_notice: { sub_agents: ["sa-bypass"], resume: false },
    },
  });
  const notice = screen
    .getByText("1 sub-agent lost contact when ticketd quit")
    .closest("section") as HTMLElement;
  expect(notice.textContent).toContain("Your next message tells Codex.");
  expect(notice.textContent).not.toContain("resume");
});

test("the message sent with the note shows a caption that opens to the exact note", async () => {
  await open(fixtures().restartSent);
  expect(screen.queryByText(/lost contact when ticketd quit/)).toBeNull();
  const caption = screen.getByRole("button", {
    name: "With a note on 2 lost sub-agents",
  });
  expect(caption.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByText(/^From ticketd:/)).toBeNull();
  fireEvent.click(caption);
  expect(caption.getAttribute("aria-expanded")).toBe("true");
  expect(
    screen.getByText(
      "From ticketd: these sub-agents were running when ticketd quit and are not running now: Find limiter bypasses, Check limiter test coverage. You can resume them.",
    ),
  ).toBeTruthy();
  fireEvent.click(caption);
  expect(screen.queryByText(/^From ticketd:/)).toBeNull();
});

test("the Chat's one polite status says the work goes on, and a request is announced by its title", async () => {
  await open(fixtures().reply);
  const status = () =>
    [...document.querySelectorAll('.chat-dock .sr-only[aria-live="polite"]')]
      .map((one) => one.textContent)
      .filter(Boolean)
      .join("|");
  expect(status()).toBe("2 sub-agents running");
  cleanup();
  await open(fixtures().approval);
  await screen.findByRole("group", { name: /wants to run/ });
  expect(status()).toBe(
    "Check limiter test coverage wants to run npm test -- rate-limit",
  );
});

test("Esc in a sub-agent's view goes back and stops nothing", async () => {
  const client = await open(fixtures().reply);
  const stop = vi.spyOn(client, "stop");
  const stopOne = vi.spyOn(client, "stopSubAgent");
  const open1 = screen.getByRole("button", {
    name: /^Sub-agent Find limiter bypasses/,
  });
  fireEvent.click(open1);
  const heading = await screen.findByRole("heading", {
    name: "Find limiter bypasses",
  });
  fireEvent.keyDown(heading, { key: "Escape" });
  await screen.findByRole("heading", { name: "Review the rate limiter" });
  expect(stop).not.toHaveBeenCalled();
  expect(stopOne).not.toHaveBeenCalled();
});

test("a turn that holds sub-agent rows is never skipped by content-visibility", async () => {
  // WebKit keeps such a turn skipped after Back focuses its row and focus then
  // leaves: the rows go blank and dead (T-UB282, WK-1). Other turns keep the rule.
  await open(fixtures().reply);
  const holding = document
    .querySelector(".chat-subagent")
    ?.closest(".chat-turnpart");
  expect(holding?.hasAttribute("data-subagents")).toBe(true);
  const others = [...document.querySelectorAll(".chat-turnpart")].filter(
    (part) => part !== holding,
  );
  for (const part of others)
    expect(part.hasAttribute("data-subagents")).toBe(false);
  expect(chatsCss).toMatch(
    /\.chat-turnpart\[data-subagents\] \{\s*content-visibility: visible/,
  );
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 800));

test("while the main agent only waits on running sub-agents, there is no working line", async () => {
  // The host says it is "Working"; the spinning rows and the strip are the live signal.
  const base = fixtures().inTurn;
  await open({
    ...base,
    chat: {
      ...base.chat,
      doing: {
        label: "Working",
        since: new Date(Date.now() - 60_000).toISOString(),
      },
    },
  });
  await settle();
  expect(
    screen.getByRole("button", { name: "Stop the turn and 2 sub-agents" }),
  ).toBeTruthy();
  expect(document.querySelector(".chat-working")).toBeNull();
});

test("the working line still shows while the main agent writes, sub-agents or not", async () => {
  const base = fixtures().inTurn;
  const turn = base.items?.find(
    (item) => item.kind === "turn" && item.outcome === "active",
  );
  await open({
    ...base,
    items: [
      ...(base.items ?? []),
      {
        id: "r-live",
        at: new Date().toISOString(),
        turn_id: turn?.kind === "turn" ? turn.turn_id : "t1",
        kind: "response",
        state: "streaming",
        text: "Looking at the",
      },
    ],
  });
  expect(
    (await screen.findByText("Writing")).closest(".chat-working"),
  ).not.toBeNull();
});
